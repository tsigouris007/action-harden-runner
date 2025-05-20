// src/post.js
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
  formatIptablesOutput,
  displayTables,
  logger,
  getUniqueRows,
} = require("./utils");
const { fetchAbuseCHData } = require("./abusech");
const { log } = require("console");

const tempRunnerPath = "/home/runner/work/_temp";
const debugMode = process.env["INPUT_DEBUG"] === "true";
const mode = process.env["INPUT_MODE"] || "log";
const abuseCHAPIKey = process.env["INPUT_ABUSECH_API_KEY"] || "";
const diskWriteInterval = 2; // Write to disk every 2 seconds
const workspace = process.env.GITHUB_WORKSPACE;
const pidFilePath = path.join(fs.realpathSync(workspace), "harden-runner.pid");
const cachedPidFilePath = path.join(tempRunnerPath, "harden-runner.pid");
const tempFilePath = path.join(
  fs.realpathSync(workspace),
  "harden-runner-connections.json",
);
const summaryFilePath = path.join(
  fs.realpathSync(workspace),
  "harden-runner-summary.json",
);
const logFilePath = path.join(tempRunnerPath, "harden-runner.log");
const actionSummaryPath = process.env.GITHUB_STEP_SUMMARY;

function sleepSync(milliseconds) {
  const start = Date.now();
  while (Date.now() - start < milliseconds) {
    // Busy-wait loop
  }
}

// Conditional fields from abuseCH
const getAbuseCHFields = (abuseCHDetails) => {
  if (!abuseCHAPIKey) return {};
  return {
    isWhitelisted: abuseCHDetails.isWhitelisted ?? "",
    abuseConfidenceScore: abuseCHDetails.abuseConfidenceScore ?? "",
    isp: abuseCHDetails.isp ?? "",
    domain: abuseCHDetails.domain ?? "",
    isTor: abuseCHDetails.isTor ?? "",
    countryCode: abuseCHDetails.countryCode ?? "",
    totalReports: abuseCHDetails.totalReports ?? "",
    lastReportedAt: abuseCHDetails.lastReportedAt ?? "",
    severity: abuseCHDetails.severity ?? "",
  };
};

const isPidRunning = (pid) => {
  try {
    process.kill(pid, 0); // Send signal 0 to test if process is alive
    return true;
  } catch (e) {
    return false;
  }
};

// Sleep synchronously for 2 seconds to allow the background process to finish writing
sleepSync(diskWriteInterval * 1000);

if (debugMode) {
  logger("🏁 Slept for a bit to finish, continuing execution...");
  logger(`🔍 Searching for PID file at: ${pidFilePath}`);
  logger(`🔍 Searching for cached PID file at: ${cachedPidFilePath}`);
  logger(`🔍 Searching for harden-runner-connections.json at: ${tempFilePath}`);
  logger(`🔍 Searching for summary file at: ${summaryFilePath}`);
  if (abuseCHAPIKey) logger("🔍 AbuseCH API Key is set");

  if (mode === "block") {
    logger("\n🔍 Fetching iptables (IPv4) Rules:");
    try {
      const ipv4Rules = execSync("sudo iptables -L -n -v").toString();
      const formattedIpv4 = formatIptablesOutput(ipv4Rules);
      displayTables(formattedIpv4, "IPv4 iptables Rules");
    } catch (error) {
      logger(
        `❌ Failed to fetch iptables (IPv4) rules: ${error.message}`,
        "error",
      );
    }

    logger("\n🔍 Fetching ip6tables (IPv6) Rules:");
    try {
      const ipv6Rules = execSync("sudo ip6tables -L -n -v").toString();
      const formattedIpv6 = formatIptablesOutput(ipv6Rules);
      displayTables(formattedIpv6, "IPv6 ip6tables Rules");
    } catch (error) {
      logger(
        `❌ Failed to fetch ip6tables (IPv6) rules: ${error.message}`,
        "error",
      );
    }
  }
}

// Try reading the cached file if the main one is missing
let pid;
if (fs.existsSync(pidFilePath)) {
  if (debugMode) logger(`📌 PID file found at ${pidFilePath}`);
  pid = parseInt(fs.readFileSync(pidFilePath, "utf-8"), 10);
} else if (fs.existsSync(cachedPidFilePath)) {
  if (debugMode) logger(`📌 PID file found at cached ${cachedPidFilePath}`);
  pid = parseInt(fs.readFileSync(cachedPidFilePath, "utf-8"), 10);
}

if (pid) {
  if (debugMode) logger(`🛑 Stopping background process with PID ${pid}`);

  if (isPidRunning(pid)) {
    if (debugMode) logger(`✅ Process ${pid} is running. Terminating...`);
    process.kill(pid);
  }

  if (fs.existsSync(pidFilePath)) fs.unlinkSync(pidFilePath);
  if (fs.existsSync(cachedPidFilePath)) fs.unlinkSync(cachedPidFilePath);
} else {
  logger(
    "⚠️ PID file not found. Process may not have started or may have ended already.",
  );
}

// Generate the summary if connections exist
if (fs.existsSync(tempFilePath)) {
  if (debugMode)
    logger("📌 harden-runner-connections.json found. Generating summary...");

  const connectionsData = JSON.parse(fs.readFileSync(tempFilePath, "utf-8"));

  const generateSummary = async () => {
    const summary = [];
    const abusechCache = new Map();

    for (const conn of connectionsData) {
      let abuseCHDetails = {};
      if (abuseCHAPIKey) {
        try {
          // Check if the IP is already in the cache
          if (abusechCache.has(conn.remote_ip))
            abuseCHDetails = abusechCache.get(conn.remote_ip);
          else
            abuseCHDetails = await fetchAbuseCHData(
              conn.remote_ip,
              abuseCHAPIKey,
            );
          if (abuseCHDetails) abusechCache.set(conn.remote_ip, abuseCHDetails);
        } catch (error) {
          if (debugMode)
            logger(
              `❌ Failed to fetch data from AbuseCH API: ${error.message}`,
              "error",
            );
        }
      }

      summary.push({
        Protocol: conn.protocol,
        LocalIP: conn.local_ip,
        LocalPort: conn.local_port,
        RemoteIP: conn.remote_ip,
        RemotePort: conn.remote_port,
        PID: conn.pid,
        Process: conn.process,
        IPv: conn.ipv,
        Domain: conn.domain,
        State: conn.state,
        Status: conn.status,
        ...getAbuseCHFields(abuseCHDetails),
      });
    }

    return summary;
  };

  generateSummary()
    .then((summary) => {
      // Base columns
      const columns = [
        { name: "Protocol", alignment: "left" },
        { name: "IPv", alignment: "left" },
        { name: "LocalIP", alignment: "left" },
        { name: "LocalPort", alignment: "left" },
        { name: "RemoteIP", alignment: "left" },
        { name: "RemotePort", alignment: "left" },
        { name: "PID", alignment: "left" },
        { name: "Process", alignment: "left" },
        { name: "Domain", alignment: "left" },
        { name: "State", alignment: "left" },
        { name: "Status", alignment: "left" },
      ];

      if (abuseCHAPIKey) {
        logger("🔍 Fetching additional data from AbuseCH API");
        columns.push(
          { name: "isWhitelisted", alignment: "left" },
          { name: "abuseConfidenceScore", alignment: "left" },
          { name: "isp", alignment: "left" },
          { name: "domain", alignment: "left" },
          { name: "isTor", alignment: "left" },
          { name: "countryCode", alignment: "left" },
          { name: "totalReports", alignment: "left" },
          { name: "lastReportedAt", alignment: "left" },
          { name: "severity", alignment: "left" },
        );
      }

      const columnNames = columns.map((col) => col.name);
      const markdownTable = [];
      markdownTable.push(`| ${columnNames.join(" | ")} |`);
      markdownTable.push(`| ${columnNames.map(() => "---").join(" | ")} |`);

      uniqueRowSummary = getUniqueRows(summary);

      uniqueRowSummary.forEach((row) => {
        const rowData = columnNames.map((col) => row[col] ?? "N/A");
        markdownTable.push(`| ${rowData.join(" | ")} |`);
      });

      const markdownContent = markdownTable.join("\n");
      fs.appendFileSync(actionSummaryPath, `## Connection Report\n\n`);
      fs.appendFileSync(actionSummaryPath, markdownContent);
      fs.appendFileSync(actionSummaryPath, `\n\n---\n`);

      fs.writeFileSync(summaryFilePath, JSON.stringify(summary, null, 2));
      if (debugMode) logger(`✅ Summary written to ${summaryFilePath}`);
      fs.unlinkSync(summaryFilePath);
      if (debugMode) logger(`✅ Summary file deleted.`);
    })
    .catch((error) => {
      logger(`❌ Failed to generate summary: ${error.message}`, "error");
    });
} else {
  logger("⚠️ No connection data found.");
}

// Print the entire cached log file for monitor.js
try {
  const logContents = fs.readFileSync(logFilePath, "utf8");
  logger(`\n${logContents}`, "info", false, true);
} catch (error) {
  if (debugMode)
    logger(
      `❌ Failed to read log file: ${error.message}`,
      "error",
      false,
      true,
    );
}

logger("🏁 Finished execution.");
