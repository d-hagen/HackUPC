from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import streamlit as st
from streamlit_autorefresh import st_autorefresh


DEFAULT_STATE_FILE = Path(__file__).resolve().parent / "dashboard-state.json"
DEFAULT_COMMAND_FILE = Path(__file__).resolve().parent / "dashboard-commands.jsonl"


def _state_path() -> Path:
    configured = os.getenv("DASHBOARD_STATE_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    return DEFAULT_STATE_FILE


def _commands_path(state: dict[str, Any] | None = None) -> Path:
    configured = os.getenv("DASHBOARD_COMMANDS_PATH")
    if configured:
        return Path(configured).expanduser().resolve()

    if state and isinstance(state.get("dashboardCommandsPath"), str):
        return Path(state["dashboardCommandsPath"]).expanduser().resolve()

    return DEFAULT_COMMAND_FILE


def _load_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            return raw
        return None
    except Exception:
        return None


def _fmt_points(rep: dict[str, Any]) -> str:
    donated = int(rep.get("donated", 0))
    consumed = int(rep.get("consumed", 0))
    balance = donated - consumed
    sign = "+" if balance >= 0 else ""
    return f"{sign}{balance} pts"


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _render_missing(path: Path) -> None:
    st.warning("No dashboard state found yet.")
    st.markdown(
        "Start requester mode first so it can publish live state to a JSON file."
    )
    st.code(
        "cd app\n"
        "node request-compute.js\n"
        "streamlit run streamlit_dashboard.py"
    )
    st.caption(f"Expected state file: {path}")


def _queue_command(command_path: Path, command_text: str) -> tuple[bool, str]:
    command = command_text.strip()
    if not command:
        return False, "Command cannot be empty."

    payload = {
        "id": str(uuid.uuid4()),
        "command": command,
        "source": "streamlit",
        "ts": int(time.time() * 1000),
    }

    try:
        command_path.parent.mkdir(parents=True, exist_ok=True)
        with command_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload) + "\n")
        return True, f"Queued: {command}"
    except Exception as exc:
        return False, f"Failed to queue command: {exc}"


def _render_header(state: dict[str, Any], path: Path) -> None:
    rep = state.get("reputation", {}) if isinstance(state.get("reputation"), dict) else {}
    workers = _safe_int(state.get("workerCount", 0))
    pending = _safe_int(state.get("pendingTaskCount", 0))
    recent_results = state.get("results", []) if isinstance(state.get("results"), list) else []
    finished = len(recent_results)

    st.title("PeerCompute Admin Dashboard")
    st.caption("Phase 2 - live monitoring with command controls")

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Workers Online", workers)
    c2.metric("Pending Tasks", pending)
    c3.metric("Recent Results", finished)
    c4.metric("Point Balance", _fmt_points(rep))

    generated_at = _safe_int(state.get("generatedAt", 0))
    if generated_at > 0:
        st.caption(f"Updated at Unix ms: {generated_at}")
    st.caption(f"State source: {path}")


def _render_network(state: dict[str, Any]) -> None:
    st.subheader("P2P Network Topology")
    workers = state.get("workers", []) if isinstance(state.get("workers"), list) else []
    req_id = state.get("requesterId", "Me")[:8]
    
    dot = [
        "digraph G {",
        "  rankdir=LR;",
        "  node [shape=box, style=filled, fontname=monospace, color=black, fillcolor=white, penwidth=2];",
        f'  "{req_id}" [label="Requester\\n{req_id}", shape=ellipse, fillcolor=lightblue];'
    ]
    
    if not workers:
        dot.append("}")
        st.graphviz_chart("\n".join(dot))
        return

    for w in workers:
        w_id = str(w.get("id", "unknown"))[:8]
        is_banned = w.get("banned", False)
        is_prioritized = w.get("prioritized", False)
        
        status_labels = []
        color = "white"
        if is_banned:
            status_labels.append("Banned")
            color = "lightpink"
        elif is_prioritized:
            status_labels.append("Prioritized")
            color = "lightgreen"
            
        label = f'Worker\\n{w_id}'
        if status_labels:
            label += f'\\n({", ".join(status_labels)})'
            
        dot.append(f'  "{w_id}" [label="{label}", fillcolor={color}];')
        
        # Connect requester to worker
        edge_style = "dashed" if is_banned else "bold"
        edge_color = "red" if is_banned else "forestgreen" if is_prioritized else "gray30"
        
        dot.append(f'  "{req_id}" -> "{w_id}" [style="{edge_style}", color="{edge_color}"];')

    dot.append("}")
    st.graphviz_chart("\n".join(dot))


def _render_workers(state: dict[str, Any]) -> None:
    pending = state.get("pendingJoinRequests", []) if isinstance(state.get("pendingJoinRequests"), list) else []
    if pending:
        st.warning(f"🔔 {len(pending)} worker(s) waiting for approval. Use the Manage Workers sidebar to Accept or Reject them.")
        p_rows = []
        for p in pending:
            p_rows.append({
                "worker_id": str(p.get("id", "unknown"))[:8],
                "status": "pending",
                "waiting_seconds": _safe_int(p.get("ageSeconds", 0))
            })
        st.dataframe(p_rows, use_container_width=True)

    workers = state.get("workers", []) if isinstance(state.get("workers"), list) else []
    st.subheader("Workers & Reputation")
    if not workers:
        st.info("No workers discovered yet.")
        return

    rows = []
    stale_count = 0
    for worker in workers:
        age = _safe_int(worker.get("ageSeconds", 0))
        is_stale = age > 30
        if is_stale:
            stale_count += 1
            
        status = "live"
        if is_stale: status = "stale"
        if worker.get("banned"): status = "BANNED"
        if worker.get("prioritized"): status = "PRIORITY"

        rows.append(
            {
                "worker_id": str(worker.get("id", "unknown"))[:8],
                "status": status,
                "tasks_done": _safe_int(worker.get("completedTasks", 0)),
                "age_seconds": age,
                "queued_tasks": _safe_int(worker.get("pendingTasks", 0)),
            }
        )

    if stale_count > 0:
        st.warning(f"{stale_count} worker(s) stale (>30s).")

    st.dataframe(rows, use_container_width=True)


def _render_jobs(state: dict[str, Any]) -> None:
    jobs = state.get("jobs", []) if isinstance(state.get("jobs"), list) else []
    st.subheader("Active Jobs")

    if not jobs:
        st.info("No active split jobs.")
        return

    rows = []
    for job in jobs:
        total = _safe_int(job.get("totalChunks", 0))
        done = _safe_int(job.get("completedChunks", 0))
        remaining = _safe_int(job.get("remainingChunks", max(total - done, 0)))
        progress = float(job.get("progress", 0)) if total > 0 else 0.0
        rows.append(
            {
                "job_id": str(job.get("jobId", ""))[:8],
                "completed_chunks": done,
                "remaining_chunks": remaining,
                "total_chunks": total,
                "progress": f"{round(progress * 100, 1)}%",
            }
        )

    st.dataframe(rows, use_container_width=True)


def _render_activity(state: dict[str, Any]) -> None:
    results = state.get("results", []) if isinstance(state.get("results"), list) else []
    st.subheader("Recent Activity")

    if not results:
        st.info("No recent results yet.")
        return

    rows = []
    for result in results[:12]:
        task_id = str(result.get("taskId", ""))[:8]
        job_id = str(result.get("jobId", ""))[:8] if result.get("jobId") else ""
        chunk = result.get("chunkIndex")
        if chunk is None:
            chunk_label = ""
        else:
            chunk_label = str(_safe_int(chunk, 0) + 1)

        error = result.get("error")
        rows.append(
            {
                "task_id": task_id,
                "job_id": job_id,
                "chunk": chunk_label,
                "status": "error" if error else "ok",
                "preview": str(error or result.get("preview") or "")[:120],
            }
        )

    st.dataframe(rows, use_container_width=True)


def main() -> None:
    st.set_page_config(page_title="PeerCompute Dashboard", page_icon="CPU", layout="wide")

    state_path = _state_path()
    refresh_enabled = st.sidebar.toggle("Auto refresh", value=True)
    refresh_seconds = st.sidebar.slider("Refresh interval (seconds)", 1, 15, 2)
    if refresh_enabled:
        st_autorefresh(interval=refresh_seconds * 1000, key="dashboard_refresh")

    st.sidebar.header("Controls")
    st.sidebar.caption("Phase 2 controls submit commands to the requester queue.")

    state = _load_state(state_path)
    if state is None:
        _render_missing(state_path)
        return

    command_path = _commands_path(state)
    st.sidebar.caption(f"Command queue: {command_path}")

    with st.sidebar.form("upload_file_form", clear_on_submit=True):
        st.subheader("Upload & Run File")
        uploaded_file = st.file_uploader("Upload JS file", type=["js"])
        run_mode = st.radio("Execution Mode", ["Distributed Job (job)", "Single Task (file)"], index=0)
        chunk_count = st.number_input("Chunks (for Job: 0 = auto)", min_value=0, value=0, step=1)
        submit_file = st.form_submit_button("Queue Uploaded File")
    if submit_file and uploaded_file is not None:
        save_dir = Path(__file__).resolve().parent / "jobs"
        save_dir.mkdir(parents=True, exist_ok=True)
        safe_name = f"{uuid.uuid4().hex[:8]}_{uploaded_file.name}"
        file_path = save_dir / safe_name
        try:
            with file_path.open("wb") as f:
                f.write(uploaded_file.getbuffer())
            cmd_type = "job" if "Job" in run_mode else "file"
            cmd_str = f"{cmd_type} jobs/{safe_name}"
            if cmd_type == "job" and int(chunk_count) > 0:
                cmd_str += f" {int(chunk_count)}"
            ok, msg = _queue_command(command_path, cmd_str)
            if ok:
                st.sidebar.success(f"Queued: {cmd_str}")
            else:
                st.sidebar.error(msg)
        except Exception as e:
            st.sidebar.error(f"Failed to save file: {e}")
    elif submit_file:
        st.sidebar.warning("Please upload a file first.")

    with st.sidebar.form("run_js_form", clear_on_submit=True):
        js_code = st.text_area("Run JS code", placeholder="return 2 + 2")
        submit_js = st.form_submit_button("Queue run")
    if submit_js:
        ok, msg = _queue_command(command_path, f"run {js_code}")
        if ok:
            st.sidebar.success(msg)
        else:
            st.sidebar.error(msg)

    with st.sidebar.form("shell_form", clear_on_submit=True):
        shell_command = st.text_input("Run shell command", placeholder="python3 --version")
        timeout_ms = st.number_input("Shell timeout (ms)", min_value=1000, max_value=300000, value=60000, step=1000)
        submit_shell = st.form_submit_button("Queue shell")
    if submit_shell:
        ok, msg = _queue_command(command_path, f"shell --timeout {int(timeout_ms)} {shell_command}")
        if ok:
            st.sidebar.success(msg)
        else:
            st.sidebar.error(msg)
            
    with st.sidebar.form("worker_action_form", clear_on_submit=True):
        st.subheader("Manage Workers")
        worker_id_input = st.text_input("Worker ID prefix")
        action = st.selectbox("Action", ["Ban", "Unban", "Prioritize", "Unprioritize", "Accept", "Reject"])
        submit_action = st.form_submit_button("Apply to Worker")
    if submit_action and worker_id_input:
        cmd_str = f"{action.lower()} {worker_id_input.strip()}"
        ok, msg = _queue_command(command_path, cmd_str)
        if ok:
            st.sidebar.success(msg)
        else:
            st.sidebar.error(msg)

    quick = st.sidebar.columns(2)
    if quick[0].button("Queue status"):
        ok, msg = _queue_command(command_path, "status")
        if ok:
            st.sidebar.success(msg)
        else:
            st.sidebar.error(msg)
    if quick[1].button("Queue workers"):
        ok, msg = _queue_command(command_path, "workers")
        if ok:
            st.sidebar.success(msg)
        else:
            st.sidebar.error(msg)

    _render_header(state, state_path)
    _render_network(state)
    
    left, right = st.columns([1.2, 1])
    with left:
        _render_workers(state)
        _render_jobs(state)
    with right:
        _render_activity(state)


if __name__ == "__main__":
    main()
