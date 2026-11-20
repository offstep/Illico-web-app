import {
  ChannelType,
  Guild,
  OverwriteResolvable,
  PermissionFlagsBits as P,
  TextChannel,
} from "discord.js";
import { DeliveryStatus as S, MissionType, MissionWorkerStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { getConfigValue } from "../config/guildConfig";
import { logAction } from "./audit.service";
import { promoteToVerified } from "./roles.service";
import { parseClassification } from "./classification";
import { ACTIVE, EDITABLE, Scores, canSubmit } from "../lib/status";
import { pad } from "../lib/format";
import {
  correctionScreen,
  qaCard,
  qaCardDone,
  submittedScreen,
  ticketScreen,
  trialSuccessScreen,
  validatedScreen,
} from "../ui/delivery";

export const PASS_SCORE = 80; // note minimale pour valider une livraison

export const loadDelivery = (id: string) =>
  prisma.delivery.findUnique({
    where: { id },
    include: { missionWorker: { include: { mission: true } }, worker: true, files: true },
  });
export type FullDelivery = NonNullable<Awaited<ReturnType<typeof loadDelivery>>>;

type Fail = { ok: false; reason: string };
const fail = (reason: string): Fail => ({ ok: false, reason });

const inFlight = new Set<string>(); // anti double-clic (process unique)

async function staffRoleIds() {
  const ids: string[] = [];
  for (const key of ["role.qa", "role.manager", "role.founder"]) {
    const id = await getConfigValue(key);
    if (id) ids.push(id);
  }
  return ids;
}

async function ticketChannel(guild: Guild, channelId: string | null): Promise<TextChannel | null> {
  if (!channelId) return null;
  const c = await guild.channels.fetch(channelId).catch(() => null);
  return c && c.type === ChannelType.GuildText ? c : null;
}

// ───────── Création du ticket privé ─────────

export async function openDelivery(
  guild: Guild,
  userId: string,
  mwId: string,
): Promise<{ ok: true; channelId: string } | Fail> {
  if (inFlight.has(mwId)) return fail("Création en cours, patiente quelques secondes.");
  inFlight.add(mwId);
  let deliveryId: string | null = null;

  try {
    const mw = await prisma.missionWorker.findUnique({
      where: { id: mwId },
      include: { mission: true, user: true },
    });
    if (!mw || mw.userId !== userId) return fail("Mission introuvable.");

    const existing = await prisma.delivery.findFirst({
      where: { missionWorkerId: mwId, status: { in: ACTIVE } },
    });
    if (existing?.channelId) return { ok: true, channelId: existing.channelId };
    if (mw.status !== MissionWorkerStatus.IN_PROGRESS) return fail("Cette mission n'est plus en cours.");

    const deliverId = await getConfigValue("ch.deliver");
    const deliverCh = deliverId ? await guild.channels.fetch(deliverId).catch(() => null) : null;

    const delivery = await prisma.delivery.create({ data: { missionWorkerId: mwId, workerId: userId } });
    deliveryId = delivery.id;

    const staff = await staffRoleIds();
    const overwrites: OverwriteResolvable[] = [
      { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
      {
        id: mw.user.discordId,
        allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles, P.EmbedLinks],
      },
      {
        id: guild.members.me!.id,
        allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.ManageChannels],
      },
      ...staff.map((id) => ({ id, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages] })),
    ];

    const channel = await guild.channels.create({
      name: `🎫・livraison-${pad(delivery.number)}`,
      type: ChannelType.GuildText,
      parent: deliverCh?.parentId ?? undefined,
      permissionOverwrites: overwrites,
    });

    const full = (await loadDelivery(delivery.id))!;
    const msg = await channel.send(ticketScreen(full));
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { channelId: channel.id, ticketMessageId: msg.id },
    });
    await logAction("delivery.created", userId, { deliveryNumber: delivery.number });
    return { ok: true, channelId: channel.id };
  } catch (err) {
    console.error("openDelivery error:", err);
    if (deliveryId) await prisma.delivery.delete({ where: { id: deliveryId } }).catch(() => {});
    return fail("Impossible de créer la livraison. Vérifie les permissions du bot.");
  } finally {
    inFlight.delete(mwId);
  }
}

// Met à jour le message d'interface du ticket (statut, boutons)
export async function refreshTicket(guild: Guild, deliveryId: string) {
  const d = await loadDelivery(deliveryId);
  if (!d?.ticketMessageId) return;
  const channel = await ticketChannel(guild, d.channelId);
  const msg = await channel?.messages.fetch(d.ticketMessageId).catch(() => null);
  await msg?.edit(ticketScreen(d)).catch(console.error);
}

// ───────── Réponse du worker ─────────

export async function saveAnswer(
  deliveryId: string,
  userId: string,
  raw: string,
): Promise<Fail | { ok: true; valid: boolean; errors: string[] }> {
  const d = await loadDelivery(deliveryId);
  if (!d || d.workerId !== userId) return fail("Livraison introuvable.");
  if (!EDITABLE.includes(d.status)) return fail("Cette livraison n'est plus modifiable.");

  const m = d.missionWorker.mission;
  const text = raw.trim();
  let answers: Prisma.InputJsonValue | null = null;
  let errors: string[] = [];

  if (!text) errors = ["La réponse est vide."];
  else if (m.type === MissionType.TRIAL) {
    const parsed = parseClassification(text, m.taskCount);
    if (parsed.ok) answers = parsed.answers;
    else errors = parsed.errors;
  } else answers = { text };

  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { rawText: text || null, textAnswer: answers ?? Prisma.DbNull },
  });
  return { ok: true, valid: answers !== null, errors };
}

// ───────── Soumission ─────────

export async function submitDelivery(guild: Guild, deliveryId: string, userId: string): Promise<{ ok: true } | Fail> {
  const d = await loadDelivery(deliveryId);
  if (!d || d.workerId !== userId) return fail("Livraison introuvable.");
  const check = canSubmit(d);
  if (!check.ok) return check;

  // Transition atomique : un double clic ne soumet qu'une fois
  const upd = await prisma.delivery.updateMany({
    where: { id: d.id, status: { in: EDITABLE } },
    data: { status: S.SUBMITTED, submittedAt: new Date() },
  });
  if (upd.count === 0) return fail("Cette livraison a déjà été soumise.");

  await prisma.missionWorker.update({
    where: { id: d.missionWorkerId },
    data: { status: MissionWorkerStatus.SUBMITTED },
  });

  const channel = await ticketChannel(guild, d.channelId);
  await channel?.permissionOverwrites
    .edit(d.worker.discordId, { SendMessages: false })
    .catch(console.error);
  await refreshTicket(guild, d.id);
  await channel?.send(submittedScreen());
  await postQaCard(guild, d.id);
  await logAction("delivery.submitted", userId, { deliveryNumber: d.number });
  return { ok: true };
}

// Envoie la carte de contrôle qualité dans le salon QA.
// Avant : en cas de problème, la fonction s'arrêtait en silence (livraison « soumise » mais
// jamais visible côté QA). Maintenant : chaque échec est écrit dans les logs.
async function postQaCard(guild: Guild, deliveryId: string) {
  const d = await loadDelivery(deliveryId);
  if (!d) return;
  const tag = `[QA] Livraison #${pad(d.number)} non postée`;

  const qaChannelId = await getConfigValue("ch.qa");
  if (!qaChannelId) {
    console.warn(`${tag} : "ch.qa" est absent de GuildConfig. Lance /setup-illico.`);
    return;
  }
  const qaChannel = await ticketChannel(guild, qaChannelId);
  if (!qaChannel) {
    console.warn(`${tag} : salon ${qaChannelId} introuvable ou inaccessible. Lance /setup-illico.`);
    return;
  }

  try {
    const round = (await prisma.qualityReview.count({ where: { deliveryId } })) + 1;
    const roleId = await getConfigValue("role.qa");
    const msg = await qaChannel.send({
      content: roleId ? `<@&${roleId}>` : undefined,
      allowedMentions: { roles: roleId ? [roleId] : [] },
      ...qaCard(d, round),
    });
    await prisma.delivery.update({ where: { id: deliveryId }, data: { qaMessageId: msg.id } });
  } catch (err) {
    console.error(`${tag} :`, err);
  }
}

// ───────── Annulation ─────────

export async function cancelDelivery(guild: Guild, deliveryId: string, userId: string): Promise<{ ok: true } | Fail> {
  const d = await loadDelivery(deliveryId);
  if (!d || d.workerId !== userId) return fail("Livraison introuvable.");

  const upd = await prisma.delivery.updateMany({
    where: { id: d.id, status: { in: EDITABLE } },
    data: { status: S.CANCELLED },
  });
  if (upd.count === 0) return fail("Cette livraison ne peut plus être annulée.");

  await logAction("delivery.cancelled", userId, { deliveryNumber: d.number });
  const channel = await ticketChannel(guild, d.channelId);
  if (channel) setTimeout(() => channel.delete().catch(console.error), 4000);
  return { ok: true };
}

// ───────── Contrôle qualité ─────────

export async function reviewDelivery(
  guild: Guild,
  deliveryId: string,
  reviewerId: string,
  s: Scores,
  comment: string | null,
): Promise<{ ok: true; validated: boolean; score: number } | Fail> {
  const d = await loadDelivery(deliveryId);
  if (!d) return fail("Livraison introuvable.");

  const score = Math.floor((s.accuracy + s.completeness + s.instructions + s.format) / 4);
  const validated = score >= PASS_SCORE;

  const done = await prisma.$transaction(async (tx) => {
    const upd = await tx.delivery.updateMany({
      where: { id: d.id, status: { in: [S.SUBMITTED, S.IN_REVIEW] } },
      data: { status: validated ? S.VALIDATED : S.CORRECTION },
    });
    if (upd.count === 0) return false;
    await tx.qualityReview.create({
      data: { deliveryId: d.id, reviewerId, ...s, score, validated, comment },
    });
    await tx.missionWorker.update({
      where: { id: d.missionWorkerId },
      data: { status: validated ? MissionWorkerStatus.VALIDATED : MissionWorkerStatus.IN_PROGRESS },
    });

    // Portefeuille : la récompense est créditée « à payer » quand la livraison est validée.
    // Pas de crédit pour la mission d'essai. skipDuplicates + index unique sur missionWorkerId :
    // impossible de créditer deux fois la même mission.
    const m = d.missionWorker.mission;
    if (validated && m.type === MissionType.STANDARD && m.reward > 0) {
      await tx.payment.createMany({
        data: [{ userId: d.workerId, missionWorkerId: d.missionWorkerId, amount: m.reward, status: "PENDING" }],
        skipDuplicates: true,
      });
    }
    return true;
  });
  if (!done) return fail("Cette livraison a déjà été évaluée.");

  const channel = await ticketChannel(guild, d.channelId);
  if (channel) {
    if (validated) {
      await channel.send(validatedScreen(d.id, d.worker.discordId, score, s));
    } else {
      await channel.permissionOverwrites
        .edit(d.worker.discordId, { SendMessages: true })
        .catch(console.error);
      await channel.send(correctionScreen(d.id, d.worker.discordId, comment));
    }
  }
  await refreshTicket(guild, d.id);

  // Carte QA : on la ferme
  const qaChannel = await ticketChannel(guild, await getConfigValue("ch.qa"));
  const qaMsg = d.qaMessageId ? await qaChannel?.messages.fetch(d.qaMessageId).catch(() => null) : null;
  await qaMsg?.edit(qaCardDone(d, validated, score)).catch(console.error);

  await logAction("qa.reviewed", reviewerId, { deliveryNumber: d.number, score, validated });

  // Mission d'essai validée → Worker vérifié
  if (validated && d.missionWorker.mission.type === MissionType.TRIAL) {
    const r = await promoteToVerified(guild, d.worker.discordId, d.workerId);
    if (r.moved) await channel?.send(trialSuccessScreen(r.roleOk));
  }
  return { ok: true, validated, score };
}
