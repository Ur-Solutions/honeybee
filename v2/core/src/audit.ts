/**
 * Audit replay — the audit table is a complete, ordered record of every write.
 * `replayAudit` folds the audit rows into a StateDump that must deep-equal the
 * store's `dumpState()` (spec test 13). Any divergence means a write path forgot
 * or mis-recorded its audit row.
 */
import type {
  AccountLimitsRow,
  AccountRow,
  AuditRow,
  BeeRow,
  CommandRow,
  FlagRow,
  MessageRow,
  QuestionRow,
  RuntimeRow,
  SealRow,
  SelectionCursorRow,
  StateDump,
  TemplateRow,
  TrackRow,
} from "./types.ts";

export function replayAudit(rows: AuditRow[]): StateDump {
  const bees = new Map<string, BeeRow>();
  const runtimes = new Map<string, RuntimeRow>(); // key beeId#generation
  const flags = new Map<number, FlagRow>();
  const mailbox = new Map<number, MessageRow>();
  const commands = new Map<number, CommandRow>();
  const templates = new Map<string, TemplateRow>();
  const tracks = new Map<string, TrackRow>();
  const questions = new Map<string, QuestionRow>();
  const seals = new Map<string, SealRow>();
  const accounts = new Map<string, AccountRow>();
  const accountLimits = new Map<string, AccountLimitsRow>();
  const selectionCursors = new Map<string, SelectionCursorRow>();

  const rtKey = (beeId: string, generation: number) => `${beeId}#${generation}`;
  const mustBee = (id: string): BeeRow => {
    const bee = bees.get(id);
    if (!bee) throw new Error(`audit replay: unknown bee ${id}`);
    return bee;
  };
  const mustCommand = (id: number): CommandRow => {
    const command = commands.get(id);
    if (!command) throw new Error(`audit replay: unknown command ${id}`);
    return command;
  };

  for (const row of rows) {
    const p = row.payload;
    switch (row.kind) {
      case "bee.created": {
        const bee = p.bee as BeeRow;
        bees.set(bee.id, { ...bee });
        break;
      }
      case "bee.archived": {
        const bee = mustBee(p.beeId as string);
        bee.lifecycle = "archived";
        bee.archivedAt = p.archivedAt as number;
        break;
      }
      case "bee.unarchived": {
        const bee = mustBee(p.beeId as string);
        bee.lifecycle = "active";
        bee.archivedAt = null;
        break;
      }
      case "bee.provider_session": {
        const bee = mustBee(p.beeId as string);
        bee.providerSessionId = p.providerSessionId as string;
        // v6: learning the fork's own id consumed the one-shot fork seed.
        bee.forkSeed = null;
        break;
      }
      case "bee.spawn_failures": {
        mustBee(p.beeId as string).spawnFailures = p.spawnFailures as number;
        break;
      }
      case "bee.args_set": {
        const args = p.args as string[] | null;
        mustBee(p.beeId as string).args = args === null ? null : [...args];
        break;
      }
      case "bee.renamed": {
        mustBee(p.beeId as string).name = p.name as string;
        break;
      }
      case "bee.tagged": {
        mustBee(p.beeId as string).tags = [...(p.tags as string[])];
        break;
      }
      case "bee.orphaned": {
        mustBee(p.beeId as string).parentId = null;
        break;
      }
      case "bee.account_set": {
        mustBee(p.beeId as string).account = (p.account as string | null) ?? null;
        break;
      }
      case "bee.env_set": {
        mustBee(p.beeId as string).env = { ...(p.env as Record<string, string>) };
        break;
      }
      case "bee.session_rekeyed": {
        const bee = mustBee(p.beeId as string);
        bee.forkSeed = p.forkSeed as string;
        bee.providerSessionId = null;
        break;
      }
      case "account.put": {
        const account = p.account as AccountRow;
        accounts.set(account.id, { ...account });
        break;
      }
      case "account.removed": {
        const id = p.accountId as string;
        if (!accounts.delete(id)) throw new Error(`audit replay: unknown account ${id}`);
        accountLimits.delete(id);
        if (p.cursorCleared === true) selectionCursors.delete(p.harness as string);
        break;
      }
      case "account_limits.put": {
        const limits = p.limits as AccountLimitsRow;
        accountLimits.set(limits.account, { ...limits });
        break;
      }
      case "selection_cursor.set": {
        const cursor = p.cursor as SelectionCursorRow;
        selectionCursors.set(cursor.harness, { ...cursor });
        break;
      }
      case "bee.deleted": {
        const beeId = p.beeId as string;
        bees.delete(beeId);
        for (const [k, rt] of runtimes) if (rt.beeId === beeId) runtimes.delete(k);
        for (const [k, f] of flags) if (f.beeId === beeId) flags.delete(k);
        for (const [k, m] of mailbox) if (m.beeId === beeId) mailbox.delete(k);
        for (const [k, q] of questions) if (q.beeId === beeId) questions.delete(k);
        for (const [k, sl] of seals) if (sl.beeId === beeId) seals.delete(k);
        for (const id of p.settledCommandIds as number[]) {
          const command = mustCommand(id);
          command.status = "done";
          command.finishedAt = p.deletedAt as number;
        }
        break;
      }
      case "runtime.created":
      case "runtime.updated": {
        const rt = p.runtime as RuntimeRow;
        // v9 back-compat: pre-boot_evidence audit rows replay as the migrated
        // store reads them — the column default, NULL.
        runtimes.set(rtKey(rt.beeId, rt.generation), { ...rt, bootEvidence: rt.bootEvidence ?? null });
        break;
      }
      case "flag.set": {
        const flag = p.flag as FlagRow;
        flags.set(flag.id, { ...flag });
        break;
      }
      case "flag.cleared": {
        const flag = flags.get(p.flagId as number);
        if (!flag) throw new Error(`audit replay: unknown flag ${String(p.flagId)}`);
        flag.clearedAt = p.clearedAt as number;
        break;
      }
      case "mail.enqueued": {
        const message = p.message as MessageRow;
        // v8 back-compat: pre-urgency audit rows replay as the migrated
        // store reads them — the column default, `next`.
        mailbox.set(message.id, { ...message, urgency: message.urgency ?? "next" });
        break;
      }
      case "mail.delivered": {
        const message = mailbox.get(p.messageId as number);
        if (!message) throw new Error(`audit replay: unknown message ${String(p.messageId)}`);
        message.deliveredAt = p.deliveredAt as number;
        message.deliveredGeneration = p.deliveredGeneration as number;
        break;
      }
      case "command.enqueued": {
        const command = p.command as CommandRow;
        commands.set(command.id, { ...command });
        break;
      }
      case "command.claimed": {
        mustCommand(p.commandId as number).status = "running";
        break;
      }
      case "command.completed":
      case "command.moot": {
        const command = mustCommand(p.commandId as number);
        command.status = "done";
        command.finishedAt = p.finishedAt as number;
        break;
      }
      case "command.requeued": {
        const command = mustCommand(p.commandId as number);
        command.status = "queued";
        command.attempts = p.attempts as number;
        command.nextAttemptAt = p.nextAttemptAt as number;
        break;
      }
      case "command.failed": {
        const command = mustCommand(p.commandId as number);
        command.status = "failed";
        command.attempts = p.attempts as number;
        command.finishedAt = p.finishedAt as number;
        command.failureCause = p.failureCause as CommandRow["failureCause"];
        break;
      }
      case "command.boot_requeued": {
        for (const id of p.commandIds as number[]) {
          const command = mustCommand(id);
          command.status = "queued";
          command.nextAttemptAt = p.nextAttemptAt as number;
        }
        break;
      }
      case "output.recorded": {
        mustBee(p.beeId as string).lastOutputAt = p.at as number;
        break;
      }
      case "template.put": {
        const template = p.template as TemplateRow;
        templates.set(template.id, { ...template });
        break;
      }
      case "template.deleted": {
        if (!templates.delete(p.templateId as string)) throw new Error(`audit replay: unknown template ${String(p.templateId)}`);
        break;
      }
      case "track.put": {
        const track = p.track as TrackRow;
        tracks.set(track.id, { ...track });
        break;
      }
      case "track.deleted": {
        if (!tracks.delete(p.trackId as string)) throw new Error(`audit replay: unknown track ${String(p.trackId)}`);
        break;
      }
      case "question.asked": {
        const question = p.question as QuestionRow;
        questions.set(question.id, { ...question, options: question.options === null ? null : [...question.options] });
        break;
      }
      case "question.answered": {
        const question = questions.get(p.questionId as string);
        if (!question) throw new Error(`audit replay: unknown question ${String(p.questionId)}`);
        question.status = "answered";
        question.answer = p.answer as string;
        question.answeredAt = p.answeredAt as number;
        question.answeredBy = p.answeredBy as string;
        question.deliveryMessageId = p.deliveryMessageId as number;
        break;
      }
      case "seal.created": {
        const seal = p.seal as SealRow;
        seals.set(seal.id, { ...seal, refs: [...seal.refs] });
        break;
      }
      // Recorded no-ops and informational rows: state unchanged by definition.
      case "bee.imported":
      case "bee.interrupted":
      case "bee.forked":
      case "runtime.stale_update":
      case "flag.clear_noop":
      case "mail.deliver_noop":
      case "command.complete_noop":
      case "command.dedup":
      case "wake.suppressed":
      case "boot.reconciled":
        break;
      default:
        throw new Error(`audit replay: unknown audit kind ${row.kind}`);
    }
  }

  return {
    bees: [...bees.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    runtimes: [...runtimes.values()].sort((a, b) =>
      a.beeId !== b.beeId ? (a.beeId < b.beeId ? -1 : 1) : a.generation - b.generation,
    ),
    flags: [...flags.values()].sort((a, b) => a.id - b.id),
    mailbox: [...mailbox.values()].sort((a, b) => a.id - b.id),
    commands: [...commands.values()].sort((a, b) => a.id - b.id),
    templates: [...templates.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    tracks: [...tracks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    questions: [...questions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    seals: [...seals.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    accounts: [...accounts.values()].sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    accountLimits: [...accountLimits.values()].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0)),
    selectionCursors: [...selectionCursors.values()].sort((a, b) => (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0)),
  };
}
