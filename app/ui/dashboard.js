import { formatPointLedger, getPointLedger } from "../economy.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[38;2;93;201;255m";
const MAGENTA = "\x1b[38;2;224;115;255m";
const GREEN = "\x1b[38;2;84;230;168m";
const YELLOW = "\x1b[38;2;255;207;102m";
const RED = "\x1b[38;2;255;120;120m";
const WHITE = "\x1b[38;2;237;242;247m";

function paint(text, color) {
  return `${color}${text}${RESET}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width
    ? text.slice(0, width)
    : text + " ".repeat(width - text.length);
}

function progressBar(done, total, width = 18) {
  const ratio = total > 0 ? clamp(done / total, 0, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  const tone = ratio >= 1 ? GREEN : CYAN;
  return (
    paint("█".repeat(filled), tone) +
    paint("░".repeat(empty), DIM) +
    ` ${done}/${total}`
  );
}

function box(title, lines) {
  const width = Math.max(
    title.length + 6,
    ...lines.map((line) => stripAnsi(line).length + 4),
  );

  const top = `╭${"─".repeat(width - 2)}╮`;
  const heading = `│ ${paint(title, BOLD + WHITE)}${" ".repeat(width - title.length - 3)}│`;
  const body = lines.map(
    (line) => `│ ${line}${" ".repeat(width - stripAnsi(line).length - 3)}│`,
  );
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  return [top, heading, ...body, bottom].join("\n");
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-9;]*m/g, "");
}

function ageLabel(ts) {
  if (!ts) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export function renderRequesterDashboard(state) {
  return renderAdminDashboard(state);
}

function renderHeader(
  state,
  ledger,
  workerCount,
  pendingTasks,
  completedTasks,
) {
  return box("PEERPOINT // ADMIN MONITOR", [
    `${paint("Requester", CYAN)} ${state.requesterId}`,
    `${paint("Wallet", MAGENTA)} ${formatPointLedger(state.reputation)}  ${paint("Rule", DIM)} one task = one point`,
    `${paint("Network", GREEN)} ${workerCount} worker(s) online  ${pendingTasks} task(s) waiting  ${completedTasks} result(s) received`,
  ]);
}

function renderMiniMetric(label, value, tone = CYAN) {
  return `${paint(label, DIM)} ${paint(value, tone)}`;
}

function renderFleetHealth(state) {
  const liveWorkers = state.workers.filter((worker) => worker.ageSeconds <= 30);
  const staleWorkers = state.workers.length - liveWorkers.length;
  const activeJobs = state.jobs.filter(
    (job) => job.results.size < job.totalChunks,
  );
  const pendingChunkCount = activeJobs.reduce(
    (total, job) => total + Math.max(0, job.totalChunks - job.results.size),
    0,
  );

  return box("SYSTEM HEALTH", [
    `${renderMiniMetric("workers", `${liveWorkers.length} live / ${staleWorkers} stale`, staleWorkers > 0 ? YELLOW : GREEN)}`,
    `${renderMiniMetric("jobs", `${activeJobs.length} active`, activeJobs.length > 0 ? CYAN : DIM)}`,
    `${renderMiniMetric("chunks", `${pendingChunkCount} pending`, pendingChunkCount > 0 ? CYAN : GREEN)}`,
    `${renderMiniMetric("points", formatPointLedger(state.reputation), getPointLedger(state.reputation).balance >= 0 ? GREEN : RED)}`,
  ]);
}

function renderEconomy(state, ledger) {
  return box("POINT ECONOMY", [
    `earned ${paint(String(ledger.donated), GREEN)} | spent ${paint(String(ledger.consumed), YELLOW)} | balance ${paint(formatPointLedger(state.reputation), ledger.balance >= 0 ? GREEN : RED)}`,
    `${paint("Submit", CYAN)} costs 1 point  ${paint("Complete", GREEN)} earns 1 point`,
    `${paint("Backlog", DIM)} ${state.pendingTaskCount} task(s) queued  ${paint("Net if cleared", DIM)} ${paint(`${ledger.balance - state.pendingTaskCount} pts`, ledger.balance >= 0 ? GREEN : RED)}`,
  ]);
}

function renderWorkerFleet(state) {
  return box(
    "ACTIVE WORKERS",
    state.workers.length > 0
      ? state.workers.map((worker, index) => {
          const isStale = worker.ageSeconds > 30;
          const status = isStale
            ? paint("stale", YELLOW)
            : paint("live", GREEN);
          const assigned =
            worker.pendingTasks > 0
              ? paint(`${worker.pendingTasks} queued`, CYAN)
              : paint("idle", DIM);
          const freshness = paint(ageLabel(worker.ts), DIM);
          return `${paint(String(index + 1).padStart(2, "0"), DIM)} ${pad(worker.id, 18)} ${status}  ${assigned}  ${freshness}`;
        })
      : [paint("No workers connected yet.", DIM)],
  );
}

function renderJobs(state) {
  const activeJobs = state.jobs.filter(
    (job) => job.results.size < job.totalChunks,
  );

  return box(
    "JOB PIPELINE",
    activeJobs.length > 0
      ? activeJobs.map((job, index) => {
          const done = job.results.size;
          const total = job.totalChunks;
          const bar = progressBar(done, total);
          const remaining = Math.max(0, total - done);
          return `${paint(String(index + 1).padStart(2, "0"), DIM)} ${pad(job.jobId.slice(0, 8), 10)} ${bar} ${paint(`${remaining} left`, DIM)}`;
        })
      : [paint("No active jobs.", DIM)],
  );
}

function renderRecentResults(state) {
  return box(
    "RECENT ACTIVITY",
    state.results.length > 0
      ? state.results.slice(0, 6).map((result, index) => {
          const label = result.error ? paint("error", RED) : paint("ok", GREEN);
          const task = result.jobId
            ? `${result.jobId.slice(0, 8)}:${result.chunkIndex + 1}`
            : result.taskId.slice(0, 8);
          const preview = result.preview || result.error || "complete";
          return `${paint(String(index + 1).padStart(2, "0"), DIM)} ${pad(task, 12)} ${label} ${preview}`;
        })
      : [paint("No results yet.", DIM)],
  );
}

export function renderAdminDashboard(state) {
  const ledger = getPointLedger(state.reputation);
  const workerCount = state.workers.length;
  const pendingTasks = state.pendingTaskCount;
  const completedTasks = state.results.length;

  const header = renderHeader(
    state,
    ledger,
    workerCount,
    pendingTasks,
    completedTasks,
  );
  const economy = renderEconomy(state, ledger);
  const workers = renderWorkerFleet(state);
  const jobs = renderJobs(state);
  const health = renderFleetHealth(state);
  const recent = renderRecentResults(state);

  return [
    header,
    "",
    health,
    "",
    economy,
    "",
    workers,
    "",
    jobs,
    "",
    recent,
  ].join("\n");
}
