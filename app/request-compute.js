// Task requester: hosts own Autobase, advertises on network, assigns tasks to workers
import { createBase, NETWORK_TOPIC } from "./base-setup.js";
import { loadReputation, getScore } from "./reputation.js";
import { formatPointLedger, spendTaskPoints } from "./economy.js";
import { renderAdminDashboard } from "./ui/dashboard.js";
import { pathToFileURL } from "url";
import { resolve, basename } from "path";
import crypto from "crypto";
import fs from "fs";
import readline from "readline";
import Hyperswarm from "hyperswarm";

const requesterId = `requester-${crypto.randomUUID().slice(0, 8)}`;
const {
  base,
  swarm: replicationSwarm,
  store,
  drive,
  cleanup,
} = await createBase("./store-requester", null);
const autobaseKey = base.key.toString("hex");
const driveKey = drive.key.toString("hex");

console.log("╔═══════════════════════════════════════════╗");
console.log("║       REQUEST COMPUTE — Requester         ║");
console.log("╠═══════════════════════════════════════════╣");
console.log(`║  ID: ${requesterId}              ║`);
console.log("╚═══════════════════════════════════════════╝");
console.log("");

// Track state
const printedResults = new Set();
const recentResults = [];
const workers = new Map(); // writerKey -> { id, ts }
const pendingJoinRequests = new Map(); // workerId -> { writerKey, conn, ts }
const pendingJobs = new Map();
const taskToJob = new Map();
let pendingTaskCount = 0;
let monitorTimer = null;
let monitorMode = false;
let snapshotTimer = null;
let commandPollTimer = null;
const processedDashboardCommandIds = new Set();

const DASHBOARD_STATE_PATH = process.env.DASHBOARD_STATE_PATH
  ? resolve(process.env.DASHBOARD_STATE_PATH)
  : resolve("./dashboard-state.json");
const DASHBOARD_COMMANDS_PATH = process.env.DASHBOARD_COMMANDS_PATH
  ? resolve(process.env.DASHBOARD_COMMANDS_PATH)
  : resolve("./dashboard-commands.jsonl");

function findJobForTask(taskId) {
  return taskToJob.get(taskId) || null;
}

function safePreview(value, limit = 120) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return (text ?? "null").slice(0, limit);
  } catch {
    return "[unrenderable result]";
  }
}

function snapshotDashboard() {
  const rep = loadReputation();
  const workerRows = [...workers.entries()].map(([key, info]) => ({
    id: info.id || key.slice(0, 8),
    key,
    ts: info.ts,
    ageSeconds: Math.max(0, Math.floor((Date.now() - info.ts) / 1000)),
    pendingTasks: info.pendingTasks || 0,
    banned: !!info.banned,
    prioritized: !!info.prioritized,
    completedTasks: info.completedTasks || 0,
  }));

  const jobs = [...pendingJobs.entries()].map(([jobId, job]) => ({
    jobId,
    totalChunks: job.totalChunks,
    results: job.results,
  }));

  const pendingWorkerRows = [...pendingJoinRequests.entries()].map(
    ([id, info]) => ({
      id,
      ts: info.ts,
      ageSeconds: Math.floor((Date.now() - info.ts) / 1000),
    }),
  );

  return {
    requesterId,
    autobaseEntries: base.view.length,
    reputation: rep,
    workers: workerRows,
    pendingJoinRequests: pendingWorkerRows,
    jobs,
    pendingTaskCount,
    results: recentResults,
    monitorMode,
  };
}

function serializeSnapshot(state) {
  return {
    generatedAt: Date.now(),
    requesterId: state.requesterId,
    reputation: state.reputation,
    workerCount: state.workers.length,
    pendingTaskCount: state.pendingTaskCount,
    autobaseEntries: state.autobaseEntries,
    monitorMode: state.monitorMode,
    dashboardCommandsPath: DASHBOARD_COMMANDS_PATH,
    workers: state.workers.map((worker) => ({
      id: worker.id,
      ageSeconds: worker.ageSeconds,
      pendingTasks: worker.pendingTasks,
      lastSeenTs: worker.ts,
      banned: worker.banned,
      prioritized: worker.prioritized,
      completedTasks: worker.completedTasks,
    })),
    pendingJoinRequests: state.pendingJoinRequests.map((w) => ({
      id: w.id,
      ageSeconds: w.ageSeconds,
      lastSeenTs: w.ts,
    })),
    jobs: state.jobs.map((job) => ({
      jobId: job.jobId,
      totalChunks: job.totalChunks,
      completedChunks: job.results.size,
      remainingChunks: Math.max(0, job.totalChunks - job.results.size),
      progress:
        job.totalChunks > 0
          ? Number((job.results.size / job.totalChunks).toFixed(3))
          : 0,
    })),
    results: state.results,
  };
}

function persistSnapshot() {
  try {
    const serialized = serializeSnapshot(snapshotDashboard());
    fs.writeFileSync(DASHBOARD_STATE_PATH, JSON.stringify(serialized, null, 2));
  } catch {}
}

function startSnapshotLoop() {
  persistSnapshot();
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = setInterval(() => {
    persistSnapshot();
  }, 1500);
}

function parseDashboardCommand(line) {
  if (!line || !line.trim()) return null;
  try {
    const payload = JSON.parse(line);
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.id !== "string" || !payload.id) return null;
    if (typeof payload.command !== "string" || !payload.command.trim()) {
      return null;
    }
    return {
      id: payload.id,
      command: payload.command.trim(),
    };
  } catch {
    return null;
  }
}

async function processDashboardCommands() {
  if (!fs.existsSync(DASHBOARD_COMMANDS_PATH)) return;

  let content = "";
  try {
    content = fs.readFileSync(DASHBOARD_COMMANDS_PATH, "utf-8");
  } catch {
    return;
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseDashboardCommand(line);
    if (!parsed) continue;
    if (processedDashboardCommandIds.has(parsed.id)) continue;

    processedDashboardCommandIds.add(parsed.id);
    console.log(`\n[dashboard] ${parsed.command}`);
    try {
      await executeCommand(parsed.command, { source: "dashboard" });
    } catch (err) {
      console.log(`[dashboard] command failed: ${err.message}`);
    }
  }
}

function startDashboardCommandLoop() {
  if (commandPollTimer) clearInterval(commandPollTimer);
  commandPollTimer = setInterval(async () => {
    await processDashboardCommands();
  }, 1000);
}

function showDashboard() {
  persistSnapshot();
  process.stdout.write("\x1Bc");
  console.log(renderAdminDashboard(snapshotDashboard()));
  console.log(
    `\n${formatPointLedger(loadReputation())}  |  ${monitorMode ? "live monitor on" : "live monitor off"}  |  Type ${"help"} for commands`,
  );
}

function startMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorMode = true;
  showDashboard();
  monitorTimer = setInterval(() => {
    showDashboard();
  }, 1500);
}

function stopMonitor() {
  monitorMode = false;
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  showDashboard();
}

// --- Two swarms: discovery (JSON messaging) and replication (Autobase sync) ---

const BOOTSTRAP = process.env.BOOTSTRAP;
const swarmOpts = BOOTSTRAP
  ? {
      bootstrap: [
        {
          host: BOOTSTRAP.split(":")[0],
          port: Number(BOOTSTRAP.split(":")[1]),
        },
      ],
    }
  : {};

// Discovery swarm: NETWORK_TOPIC only, for advertisements and join handshake
const discoverySwarm = new Hyperswarm(swarmOpts);
discoverySwarm.join(NETWORK_TOPIC, { client: true, server: true });

// Replication swarm: base.discoveryKey only, for Autobase sync
replicationSwarm.join(base.discoveryKey, { client: true, server: true });
replicationSwarm.on("connection", (conn) => {
  store.replicate(conn);
});

// Periodically re-broadcast availability
const broadcastConns = new Set();

function broadcast() {
  const rep = loadReputation();
  const msg = JSON.stringify({
    type: "advertise",
    role: "requester",
    requesterId,
    autobaseKey,
    pendingTasks: pendingTaskCount,
    workerCount: workers.size,
    reputation: {
      donated: rep.donated,
      consumed: rep.consumed,
      score: getScore(rep),
    },
  });
  for (const conn of broadcastConns) {
    try {
      conn.write(msg);
    } catch {}
  }
}

discoverySwarm.on("connection", (conn) => {
  broadcastConns.add(conn);
  conn.on("close", () => broadcastConns.delete(conn));
  conn.on("error", () => broadcastConns.delete(conn));

  // Send advertisement immediately
  const rep = loadReputation();
  conn.write(
    JSON.stringify({
      type: "advertise",
      role: "requester",
      requesterId,
      autobaseKey,
      pendingTasks: pendingTaskCount,
      reputation: {
        donated: rep.donated,
        consumed: rep.consumed,
        score: getScore(rep),
      },
      workerCount: workers.size,
    }),
  );

  conn.on("data", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "join-request" && msg.role === "worker") {
        const writerKey = msg.writerKey;
        if (!workers.has(writerKey) && !pendingJoinRequests.has(msg.workerId)) {
          pendingJoinRequests.set(msg.workerId, {
            writerKey,
            conn,
            ts: Date.now(),
          });
          console.log(
            `\n[?] Worker ${msg.workerId} wants to join. Use 'accept ${msg.workerId}' or 'reject ${msg.workerId}'.`,
          );
          persistSnapshot();
          rl.prompt();
        }
      }
    } catch {}
  });

  // NO replication on discovery connections
});

Promise.all([discoverySwarm.flush(), replicationSwarm.flush()]).then(() =>
  console.log("DHT bootstrap complete."),
);
console.log("Advertising on network, waiting for workers...\n");
startSnapshotLoop();
startDashboardCommandLoop();

// Watch for results
base.on("update", async () => {
  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i);

    if (entry.type === "worker-available" && !workers.has(entry.key)) {
      workers.set(entry.key, {
        id: entry.by,
        ts: entry.ts,
        banned: false,
        prioritized: false,
        completedTasks: 0,
      });
    }

    if (entry.type === "result" && !printedResults.has(entry.taskId)) {
      printedResults.add(entry.taskId);

      // Track worker completed tasks for reputation
      for (const w of workers.values()) {
        if (w.id === entry.by) {
          w.completedTasks = (w.completedTasks || 0) + 1;
          w.ts = Date.now();
          break;
        }
      }

      const jobMatch = findJobForTask(entry.taskId);
      if (jobMatch) {
        const { jobId, chunkIndex } = jobMatch;
        const job = pendingJobs.get(jobId);
        if (job && !job.results.has(chunkIndex)) {
          const resultValue = entry.error
            ? { error: entry.error }
            : entry.output;
          job.results.set(chunkIndex, resultValue);
          recentResults.unshift({
            taskId: entry.taskId,
            jobId,
            chunkIndex,
            error: entry.error || null,
            preview: entry.error ? entry.error : safePreview(resultValue),
          });
          recentResults.splice(6);
          console.log(
            `\n[<] Chunk ${chunkIndex + 1}/${job.totalChunks} done (by ${entry.by}, ${entry.elapsed || "?"}ms)`,
          );

          if (job.results.size === job.totalChunks) {
            const errors = [...job.results.values()].filter(
              (r) => r && r.error,
            );
            if (errors.length > 0) {
              console.log(
                `[!] Job ${jobId.slice(0, 8)}… had ${errors.length} failed chunks`,
              );
            } else {
              const ordered = Array.from({ length: job.totalChunks }, (_, i) =>
                job.results.get(i),
              );
              try {
                const final = job.joinFn(ordered);
                console.log(`\n[*] JOB ${jobId.slice(0, 8)}… COMPLETE`);
                const out =
                  typeof final === "string"
                    ? final
                    : JSON.stringify(final, null, 2);
                console.log(out.length > 2000 ? out.slice(0, 2000) + "…" : out);
              } catch (err) {
                console.log(`[!] Join failed: ${err.message}`);
              }
            }
            pendingJobs.delete(jobId);
            pendingTaskCount = Math.max(0, pendingTaskCount - job.totalChunks);
            broadcast();
          }
          rl.prompt();
        }
      } else {
        recentResults.unshift({
          taskId: entry.taskId,
          error: entry.error || null,
          preview: entry.error
            ? entry.error
            : entry.output && entry.output.stdout !== undefined
              ? `exit ${entry.output.exitCode}`
              : safePreview(entry.output),
        });
        recentResults.splice(6);
        console.log(
          `\n[<] Result from ${entry.by} (task ${entry.taskId.slice(0, 8)}…)`,
        );
        if (entry.error) {
          console.log(`    Error: ${entry.error}`);
        } else if (entry.output && entry.output.stdout !== undefined) {
          console.log(`    Exit code: ${entry.output.exitCode}`);
          if (entry.output.timedOut) console.log(`    [!] Process timed out`);
          if (entry.output.stdout)
            console.log(`    stdout: ${entry.output.stdout.slice(0, 400)}`);
          if (entry.output.stderr)
            console.log(`    stderr: ${entry.output.stderr.slice(0, 200)}`);
        } else {
          const out = JSON.stringify(entry.output ?? null, null, 2);
          console.log(
            out.length > 500 ? `    ${out.slice(0, 500)}…` : `    ${out}`,
          );
        }
        if (entry.elapsed) console.log(`    (${entry.elapsed}ms)`);
        pendingTaskCount = Math.max(0, pendingTaskCount - 1);
        broadcast();
        rl.prompt();
      }
    }
  }
});

// Interactive prompt
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function showHelp() {
  console.log(`
Commands:
  run <code>           Send JS code to execute
                         run return 2 + 2
                         run return Array.from({length:10}, (_,i) => i*i)
                         Tasks with files get: readFile(path), listFiles(), writeFile(path, data)
  file <path.js>       Send a .js file as a single task
  job <path.js> [n]    Run a distributed job (split across n workers, default=all)
                         Job file exports: data, split(data,n), compute(chunk), join(results)
  shell <command>      Send a shell command to execute on a worker
                         shell python3 -c "print(2+2)"
                         shell echo hello world
                         shell --timeout 5000 sleep 10
  upload <file> [name] Upload a file to the shared drive (available to workers)
  files                List files on the shared drive
  download <path>      Download a file from worker output
  workers              List connected workers
  results              Show all results
  status               Show network status
  dashboard            Render the premium live dashboard view
  monitor              Start live admin monitoring
  stop                 Stop live admin monitoring
  ban <id>             Ban a worker by ID prefix (stops giving them job tasks)
  unban <id>           Unban a worker
  prioritize <id>      Prioritize a worker (assign them more job tasks)
  unprioritize <id>    Remove prioritize status from worker
  accept <id>          Accept a worker's join request
  reject <id>          Reject a worker's join request
  help                 Show this help
`);
}

showHelp();
rl.setPrompt("request> ");
rl.prompt();

async function executeCommand(input, options = {}) {
  const source = options.source || "cli";

  if (input.startsWith("run ")) {
    const code = input.slice(4).trim();
    if (!code) {
      console.log("[!] Usage: run <code>");
      return;
    }
    if (workers.size === 0) {
      console.log(
        "[!] No workers yet. Task queued — will run when a worker joins.",
      );
    }
    const id = crypto.randomUUID();
    pendingTaskCount++;
    broadcast();
    await base.append({
      type: "task",
      id,
      code,
      argNames: [],
      args: [],
      driveKey,
      by: requesterId,
      ts: Date.now(),
    });
    spendTaskPoints();
    broadcast();
    console.log(`[>] Task ${id.slice(0, 8)}… posted`);
  } else if (input.startsWith("job ")) {
    const parts = input.slice(4).trim().split(/\s+/);
    const filePath = parts[0];
    const nOverride = parts[1] ? parseInt(parts[1]) : null;
    try {
      const absPath = resolve(filePath);
      const mod = await import(pathToFileURL(absPath).href);

      if (!mod.split || !mod.compute || !mod.join || !mod.data) {
        console.log(
          "[!] Job file must export: data, split(data, n), compute(chunk), join(results)",
        );
        return;
      }

      const n = nOverride || Math.max(1, workers.size);
      const chunks = mod.split(mod.data, n);
      const jobId = crypto.randomUUID();
      const computeCode = mod.compute.toString();
      const code = `const compute = ${computeCode}; return compute(chunk)`;

      const validWorkers = [...workers.values()].filter((w) => !w.banned);
      validWorkers.sort((a, b) => {
        if (a.prioritized && !b.prioritized) return -1;
        if (!a.prioritized && b.prioritized) return 1;
        return (b.completedTasks || 0) - (a.completedTasks || 0); // most reliable
      });
      const workerIds = validWorkers.map((w) => w.id);
      if (workerIds.length === 0) {
        console.log(
          "[!] No workers connected. Tasks queued — will run when workers join.",
        );
      }

      console.log(
        `[>] Job ${jobId.slice(0, 8)}… splitting into ${chunks.length} chunks across ${workerIds.length || "?"} worker(s)`,
      );

      pendingJobs.set(jobId, {
        totalChunks: chunks.length,
        results: new Map(),
        joinFn: mod.join,
      });

      pendingTaskCount += chunks.length;
      broadcast();

      for (let i = 0; i < chunks.length; i++) {
        const taskId = crypto.randomUUID();
        taskToJob.set(taskId, { jobId, chunkIndex: i });
        const assignedTo =
          workerIds.length > 0 ? workerIds[i % workerIds.length] : null;
        await base.append({
          type: "task",
          id: taskId,
          jobId,
          chunkIndex: i,
          totalChunks: chunks.length,
          code,
          argNames: ["chunk"],
          args: [chunks[i]],
          assignedTo,
          driveKey,
          by: requesterId,
          ts: Date.now(),
        });
      }
      spendTaskPoints(chunks.length);
      broadcast();
      console.log(`[>] ${chunks.length} subtasks posted`);
    } catch (err) {
      console.log(`[!] Error loading job: ${err.message}`);
    }
  } else if (input.startsWith("file ")) {
    const filePath = input.slice(5).trim();
    try {
      const code = fs.readFileSync(filePath, "utf-8");
      if (workers.size === 0) {
        console.log("[!] No workers yet. Task queued.");
      }
      const id = crypto.randomUUID();
      pendingTaskCount++;
      broadcast();
      await base.append({
        type: "task",
        id,
        code,
        argNames: [],
        args: [],
        driveKey,
        by: requesterId,
        ts: Date.now(),
      });
      spendTaskPoints();
      broadcast();
      console.log(`[>] Task from ${filePath} posted (${id.slice(0, 8)}…)`);
    } catch (err) {
      console.log(`[!] Error reading file: ${err.message}`);
    }
  } else if (input.startsWith("shell ")) {
    let cmdStr = input.slice(6).trim();
    let timeout = 60000;

    const timeoutMatch = cmdStr.match(/--timeout\s+(\d+)/);
    if (timeoutMatch) {
      timeout = parseInt(timeoutMatch[1]);
      cmdStr = cmdStr.replace(/--timeout\s+\d+/, "").trim();
    }

    if (!cmdStr) {
      console.log("[!] Usage: shell <command>");
      return;
    }

    if (workers.size === 0) {
      console.log(
        "[!] No workers yet. Task queued — will run when a shell-enabled worker joins.",
      );
    }
    const id = crypto.randomUUID();
    pendingTaskCount++;
    broadcast();
    await base.append({
      type: "task",
      id,
      taskType: "shell",
      cmd: cmdStr,
      timeout,
      by: requesterId,
      ts: Date.now(),
    });
    spendTaskPoints();
    broadcast();
    console.log(
      `[>] Shell task ${id.slice(0, 8)}… posted: ${cmdStr.slice(0, 60)}`,
    );
  } else if (input === "workers") {
    if (workers.size === 0) {
      console.log("No workers connected yet.");
    } else {
      console.log(`${workers.size} worker(s):`);
      for (const [key, info] of workers) {
        console.log(`  ${info.id} — ${key.slice(0, 24)}…`);
      }
    }
  } else if (input === "results") {
    let count = 0;
    for (let i = 0; i < base.view.length; i++) {
      const entry = await base.view.get(i);
      if (entry.type === "result") {
        count++;
        const out = entry.error
          ? `Error: ${entry.error}`
          : safePreview(entry.output, 80);
        console.log(`  ${entry.taskId.slice(0, 8)}… → ${out} (by ${entry.by})`);
      }
    }
    if (count === 0) console.log("No results yet.");
  } else if (input.startsWith("upload ")) {
    const parts = input.slice(7).trim().split(/\s+/);
    const localPath = parts[0];
    const remoteName = parts[1] || "/" + basename(localPath);
    const remotePath = remoteName.startsWith("/")
      ? remoteName
      : "/" + remoteName;
    try {
      const data = fs.readFileSync(resolve(localPath));
      await drive.put(remotePath, data);
      console.log(
        `[+] Uploaded ${localPath} → ${remotePath} (${data.length} bytes)`,
      );
    } catch (err) {
      console.log(`[!] Upload failed: ${err.message}`);
    }
  } else if (input === "files") {
    let count = 0;
    for await (const entry of drive.list("/")) {
      console.log(`  ${entry.key} (${entry.value.blob.byteLength} bytes)`);
      count++;
    }
    if (count === 0) console.log("No files on drive.");
  } else if (input.startsWith("download ")) {
    const remotePath = input.slice(9).trim();
    // Check worker result drives for the file
    let found = false;
    for (let i = 0; i < base.view.length; i++) {
      const entry = await base.view.get(i);
      if (entry.type === "result" && entry.driveKey && entry.outputFiles) {
        if (entry.outputFiles.includes(remotePath)) {
          try {
            const workerDrive = new (await import("hyperdrive")).default(
              store,
              Buffer.from(entry.driveKey, "hex"),
            );
            await workerDrive.ready();
            const data = await workerDrive.get(remotePath);
            const localName = basename(remotePath);
            fs.writeFileSync(localName, data);
            console.log(
              `[+] Downloaded ${remotePath} → ./${localName} (${data.length} bytes)`,
            );
            found = true;
            break;
          } catch (err) {
            console.log(`[!] Download failed: ${err.message}`);
          }
        }
      }
    }
    if (!found) {
      // Try own drive
      try {
        const data = await drive.get(remotePath);
        if (data) {
          const localName = basename(remotePath);
          fs.writeFileSync(localName, data);
          console.log(
            `[+] Downloaded ${remotePath} → ./${localName} (${data.length} bytes)`,
          );
        } else {
          console.log(`[!] File not found: ${remotePath}`);
        }
      } catch {
        console.log(`[!] File not found: ${remotePath}`);
      }
    }
  } else if (input === "status") {
    showDashboard();
  } else if (input === "dashboard") {
    showDashboard();
  } else if (input === "monitor") {
    startMonitor();
  } else if (input === "stop") {
    stopMonitor();
  } else if (input.startsWith("ban ")) {
    const target = input.slice(4).trim();
    let count = 0;
    for (const w of workers.values()) {
      if (w.id.startsWith(target)) {
        w.banned = true;
        count++;
      }
    }
    console.log(`[+] Banned ${count} worker(s) matching ${target}`);
    persistSnapshot();
  } else if (input.startsWith("unban ")) {
    const target = input.slice(6).trim();
    let count = 0;
    for (const w of workers.values()) {
      if (w.id.startsWith(target)) {
        w.banned = false;
        count++;
      }
    }
    console.log(`[+] Unbanned ${count} worker(s) matching ${target}`);
    persistSnapshot();
  } else if (input.startsWith("prioritize ")) {
    const target = input.slice(11).trim();
    let count = 0;
    for (const w of workers.values()) {
      if (w.id.startsWith(target)) {
        w.prioritized = true;
        count++;
      }
    }
    console.log(`[+] Prioritized ${count} worker(s) matching ${target}`);
    persistSnapshot();
  } else if (input.startsWith("unprioritize ")) {
    const target = input.slice(13).trim();
    let count = 0;
    for (const w of workers.values()) {
      if (w.id.startsWith(target)) {
        w.prioritized = false;
        count++;
      }
    }
    console.log(`[+] Unprioritized ${count} worker(s) matching ${target}`);
    persistSnapshot();
  } else if (input.startsWith("accept ")) {
    const target = input.slice(7).trim();
    const req = pendingJoinRequests.get(target);
    if (!req) {
      console.log(`[!] No pending request found for ${target}.`);
    } else {
      const { writerKey, conn } = req;
      workers.set(writerKey, {
        id: target,
        ts: Date.now(),
        banned: false,
        prioritized: false,
        completedTasks: 0,
      });
      await base.append({
        type: "add-writer",
        key: writerKey,
        by: requesterId,
        ts: Date.now(),
      });
      console.log(`[+] Accepted worker: ${target}`);
      try {
        conn.write(JSON.stringify({ type: "join-accepted", autobaseKey }));
      } catch (err) {}
      pendingJoinRequests.delete(target);
      persistSnapshot();
    }
  } else if (input.startsWith("reject ")) {
    const target = input.slice(7).trim();
    const req = pendingJoinRequests.get(target);
    if (!req) {
      console.log(`[!] No pending request found for ${target}.`);
    } else {
      console.log(`[-] Rejected worker: ${target}`);
      try {
        req.conn.write(JSON.stringify({ type: "join-rejected" }));
      } catch (err) {}
      pendingJoinRequests.delete(target);
      persistSnapshot();
    }
  } else if (input === "help") {
    showHelp();
  } else {
    if (source === "dashboard") {
      console.log(
        `[!] Unsupported dashboard command: ${input}. Use run/shell/status/workers/results/files/help`,
      );
    } else {
      console.log('Unknown command. Type "help" for usage.');
    }
  }
}

rl.on("line", async (line) => {
  const input = line.trim();
  if (!input) {
    rl.prompt();
    return;
  }

  await executeCommand(input, { source: "cli" });

  rl.prompt();
});

rl.on("close", async () => {
  console.log("\nShutting down...");
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
  if (commandPollTimer) {
    clearInterval(commandPollTimer);
    commandPollTimer = null;
  }
  persistSnapshot();
  await discoverySwarm.destroy();
  await cleanup();
  process.exit();
});
