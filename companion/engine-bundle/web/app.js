const audioDrop = document.querySelector("#audioDrop");
const audioInput = document.querySelector("#audioInput");
const audioTitle = document.querySelector("#audioTitle");
const audioMeta = document.querySelector("#audioMeta");
const lyricsDrop = document.querySelector("#lyricsDrop");
const lyricsInput = document.querySelector("#lyricsInput");
const lyricsTitle = document.querySelector("#lyricsTitle");
const lyricsMeta = document.querySelector("#lyricsMeta");
const lyricsText = document.querySelector("#lyricsText");
const fileTab = document.querySelector("#fileTab");
const pasteTab = document.querySelector("#pasteTab");
const separateToggle = document.querySelector("#separateToggle");
const cacheBypassToggle = document.querySelector("#cacheBypassToggle");
const preserveBlankLinesToggle = document.querySelector(
  "#preserveBlankLinesToggle",
);
const wordTimingBetaToggle = document.querySelector(
  "#wordTimingBetaToggle",
);
const submitButton = document.querySelector("#submitButton");
const submitButtonLabel = submitButton.querySelector("span");
const formError = document.querySelector("#formError");
const queueBadge = document.querySelector("#queueBadge");
const idleState = document.querySelector("#idleState");
const runningState = document.querySelector("#runningState");
const failedState = document.querySelector("#failedState");
const resultState = document.querySelector("#resultState");
const progressValue = document.querySelector("#progressValue");
const progressDetail = document.querySelector("#progressDetail");
const progressHint = document.querySelector("#progressHint");
const orbitValue = document.querySelector("#orbitValue");
const stageLabel = document.querySelector("#stageLabel");
const failureText = document.querySelector("#failureText");
const retryButton = document.querySelector("#retryButton");
const resultSummary = document.querySelector("#resultSummary");
const downloadGrid = document.querySelector("#downloadGrid");
const languagePasses = document.querySelector("#languagePasses");
const lowConfidence = document.querySelector("#lowConfidence");
const elapsedTime = document.querySelector("#elapsedTime");
const previewBody = document.querySelector("#previewBody");

let audioFile = null;
let lyricsFile = null;
let transcriptMode = "file";
let currentJob = null;
let pollTimer = null;

const stageOrder = [
  "prepare",
  "separate",
  "recognize",
  "merge",
  "word-align",
  "done",
];
const stageNames = {
  queued: "排队中",
  prepare: "准备",
  separate: "人声分离",
  recognize: "粗锚点",
  merge: "合并",
  "word-align": "逐字对齐",
  done: "完成",
  failed: "失败",
};

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit > 1 ? 2 : 0)} ${units[unit]}`;
}

function bindDropZone(zone, input, onFile) {
  zone.addEventListener("click", (event) => {
    if (event.target === input) return;
    input.click();
  });
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    if (input.files?.[0]) onFile(input.files[0]);
  });
  ["dragenter", "dragover"].forEach((name) => {
    zone.addEventListener(name, (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    zone.addEventListener(name, (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
    });
  });
  zone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}

bindDropZone(audioDrop, audioInput, (file) => {
  audioFile = file;
  audioTitle.textContent = file.name;
  audioTitle.title = file.name;
  audioMeta.textContent = `${formatBytes(file.size)} · 将读取第一个音频流`;
  formError.textContent = "";
});

bindDropZone(lyricsDrop, lyricsInput, (file) => {
  lyricsFile = file;
  lyricsTitle.textContent = file.name;
  lyricsTitle.title = file.name;
  lyricsMeta.textContent = `${formatBytes(file.size)} · 时间轴仅用于清理，不作为提示`;
  formError.textContent = "";
});

function setTranscriptMode(mode) {
  transcriptMode = mode;
  const paste = mode === "paste";
  fileTab.classList.toggle("active", !paste);
  pasteTab.classList.toggle("active", paste);
  fileTab.setAttribute("aria-selected", String(!paste));
  pasteTab.setAttribute("aria-selected", String(paste));
  lyricsDrop.classList.toggle("hidden", paste);
  lyricsText.classList.toggle("hidden", !paste);
}

fileTab.addEventListener("click", () => setTranscriptMode("file"));
pasteTab.addEventListener("click", () => setTranscriptMode("paste"));

function showState(name) {
  idleState.classList.toggle("hidden", name !== "idle");
  runningState.classList.toggle("hidden", name !== "running");
  failedState.classList.toggle("hidden", name !== "failed");
  resultState.classList.toggle("hidden", name !== "result");
}

function setProgress(job) {
  const value = Math.max(0, Math.min(1, Number(job.progress || 0)));
  const percent = Math.round(value * 100);
  progressValue.textContent = `${percent}%`;
  orbitValue.style.strokeDashoffset = String(327 * (1 - value));
  stageLabel.textContent = stageNames[job.stage] || "处理中";
  progressDetail.textContent = job.detail || "正在处理";
  queueBadge.textContent =
    job.status === "queued" ? "GPU 队列中" : stageNames[job.stage] || "处理中";
  progressHint.textContent =
    job.status === "queued"
      ? "已有任务正在占用 GPU；当前素材会自动接续。"
      : job.bypass_cache
        ? "本次会重新分离与识别，不读取已有工作缓存。"
        : "请保持本地服务运行；同一素材再次处理会复用本机缓存。";

  const currentIndex = stageOrder.indexOf(job.stage);
  document.querySelectorAll(".stage-list > div").forEach((element, index) => {
    element.classList.toggle("complete", currentIndex > index);
    element.classList.toggle("active", currentIndex === index);
  });
}

function uploadJob(formData) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/jobs");
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const uploadProgress = Math.round((event.loaded / event.total) * 100);
      progressValue.textContent = `${uploadProgress}%`;
      stageLabel.textContent = "上传";
      progressDetail.textContent = "正在把素材交给本地服务";
      orbitValue.style.strokeDashoffset = String(
        327 * (1 - event.loaded / event.total),
      );
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response);
      } else {
        reject(new Error(request.response?.detail || "提交任务失败。"));
      }
    });
    request.addEventListener("error", () => {
      reject(new Error("无法连接本地服务。"));
    });
    request.send(formData);
  });
}

async function pollJob(jobId) {
  if (pollTimer) window.clearTimeout(pollTimer);
  try {
    const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
    const job = await response.json();
    if (!response.ok) throw new Error(job.detail || "读取任务失败。");
    currentJob = job;
    if (job.status === "complete") {
      renderResult(job);
      return;
    }
    if (job.status === "failed") {
      showState("failed");
      queueBadge.textContent = "任务失败";
      failureText.textContent = job.error || "请检查素材后重试。";
      submitButton.disabled = false;
      return;
    }
    showState("running");
    setProgress(job);
    pollTimer = window.setTimeout(() => pollJob(jobId), 900);
  } catch (error) {
    showState("failed");
    failureText.textContent = error.message;
    submitButton.disabled = false;
  }
}

function addDownload(label, hint, href, primary = false) {
  const link = document.createElement("a");
  link.className = `download-link${primary ? " primary-download" : ""}`;
  link.href = href;
  link.innerHTML = `<span>${label}</span><small>${hint}</small>`;
  downloadGrid.append(link);
}

function copyWithFallback(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("浏览器没有允许写入剪贴板。");
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      copyWithFallback(text);
      return;
    }
  }
  copyWithFallback(text);
}

function addCopyLrc(href) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-link copy-lrc-button";
  button.innerHTML = "<span>复制 LRC 文本</span><small>剪贴板</small>";
  button.addEventListener("click", async () => {
    const label = button.querySelector("span");
    const hint = button.querySelector("small");
    button.disabled = true;
    label.textContent = "正在复制";
    hint.textContent = "…";
    formError.textContent = "";
    try {
      const response = await fetch(href, { cache: "no-store" });
      if (!response.ok) throw new Error("读取 LRC 失败。");
      await copyText(await response.text());
      label.textContent = "已复制";
      hint.textContent = "LRC";
    } catch (error) {
      label.textContent = "复制失败";
      hint.textContent = "重试";
      formError.textContent = error.message;
    } finally {
      window.setTimeout(() => {
        label.textContent = "复制 LRC 文本";
        hint.textContent = "剪贴板";
        button.disabled = false;
      }, 1600);
    }
  });
  downloadGrid.append(button);
}

function renderResult(job) {
  showState("result");
  queueBadge.textContent = "已完成";
  submitButton.disabled = false;
  const summary = job.summary || {};
  const cacheLabel =
    summary.cache_policy === "bypass" ? " · 本次重新计算" : "";
  const wordBeta = summary.word_timing_beta || {};
  const wordBetaLabel = wordBeta.requested
    ? ` · 逐字 Beta ${wordBeta.aligned_lines || 0}/${summary.lines || 0} 行`
    : "";
  resultSummary.textContent = `${summary.lines || 0} 行 · ${summary.model || "本地模型"} · 未使用输入参考轴${cacheLabel}${wordBetaLabel}`;
  languagePasses.textContent = (summary.passes || []).join(" / ") || "English";
  lowConfidence.textContent = String(summary.low_confidence_lines ?? "—");
  elapsedTime.textContent = summary.processing_seconds
    ? `${summary.processing_seconds.toFixed(1)} 秒`
    : "—";

  downloadGrid.replaceChildren();
  const downloads = job.downloads || {};
  if (downloads.all) addDownload("下载全部", "ZIP", downloads.all, true);
  if (downloads.lrc3) addDownload("三位 LRC", ".xxx", downloads.lrc3);
  if (downloads.lrc3) addCopyLrc(downloads.lrc3);
  if (downloads.word_lrc) {
    addDownload("逐字 LRC", "Beta", downloads.word_lrc);
  }
  if (downloads.lrc2) addDownload("两位 LRC", ".xx", downloads.lrc2);
  if (downloads.srt) addDownload("行级 SRT", "字幕", downloads.srt);
  if (downloads.json) addDownload("诊断 JSON", "详情", downloads.json);

  previewBody.replaceChildren();
  (job.preview || []).forEach((item) => {
    const row = document.createElement("tr");
    const number = document.createElement("td");
    const time = document.createElement("td");
    const text = document.createElement("td");
    const language = document.createElement("td");
    number.textContent = item.line;
    time.textContent = item.time;
    text.textContent = item.text;
    language.textContent = item.language;
    if (item.warnings?.length) row.title = item.warnings.join(", ");
    row.append(number, time, text, language);
    previewBody.append(row);
  });
}

submitButton.addEventListener("click", async () => {
  formError.textContent = "";
  if (!audioFile) {
    formError.textContent = "请先选择音频或视频。";
    return;
  }
  if (transcriptMode === "file" && !lyricsFile) {
    formError.textContent = "请先选择 TXT、LRC 或 SRT 文字稿。";
    return;
  }
  if (transcriptMode === "paste" && !lyricsText.value.trim()) {
    formError.textContent = "请粘贴文字稿。";
    return;
  }

  const formData = new FormData();
  formData.append("audio", audioFile, audioFile.name);
  if (transcriptMode === "file") {
    formData.append("transcript", lyricsFile, lyricsFile.name);
  } else {
    formData.append("transcript_text", lyricsText.value);
  }
  formData.append("separate", String(separateToggle.checked));
  formData.append("bypass_cache", String(cacheBypassToggle.checked));
  formData.append(
    "preserve_blank_lines",
    String(preserveBlankLinesToggle.checked),
  );
  formData.append(
    "word_timing_beta",
    String(wordTimingBetaToggle.checked),
  );

  submitButton.disabled = true;
  showState("running");
  queueBadge.textContent = "正在上传";
  setProgress({
    status: "running",
    stage: "prepare",
    progress: 0,
    detail: "正在把素材交给本地服务",
    bypass_cache: cacheBypassToggle.checked,
  });
  try {
    const job = await uploadJob(formData);
    currentJob = job;
    await pollJob(job.id);
  } catch (error) {
    showState("failed");
    queueBadge.textContent = "提交失败";
    failureText.textContent = error.message;
    submitButton.disabled = false;
  }
});

cacheBypassToggle.addEventListener("change", () => {
  submitButtonLabel.textContent = cacheBypassToggle.checked
    ? "开始重新对齐"
    : "开始强制对齐";
});

retryButton.addEventListener("click", () => {
  showState("idle");
  queueBadge.textContent = "等待素材";
  formError.textContent = "";
});

fetch("/api/health", { cache: "no-store" }).catch(() => {
  formError.textContent = "本地服务尚未就绪，请运行 start.ps1。";
});
