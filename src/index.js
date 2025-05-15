// src/index.js
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { spawn, execSync } = require("child_process");
const { default: IPCIDR } = require("ip-cidr");
const { logger } = require("./utils");

const tempRunnerPath = "/home/runner/work/_temp";
const debugMode = process.env["INPUT_DEBUG"] === "true";
const interval = parseInt(process.env["INPUT_INTERVAL"] || 1);
const mode = process.env["INPUT_MODE"] || "log";
const workspace = process.env.GITHUB_WORKSPACE;
const configPath = process.env["INPUT_CONFIG"] || "default-config.yaml";
const tempFilePath = path.join(
  fs.realpathSync(workspace),
  "harden-runner-connections.json",
);
const pidFilePath = path.join(fs.realpathSync(workspace), "harden-runner.pid");
const runnerCachePath = path.join(tempRunnerPath, "harden-runner.pid");

// Check if mode is log or block
if (mode !== "log" && mode !== "block") {
  logger(`❌ Invalid mode: ${mode}. Must be 'log' or 'block'.`, "error");
  process.exit(1);
}

// Resolve the configuration file path
const configFullPath = path.isAbsolute(configPath)
  ? configPath
  : path.join(workspace, configPath);

// If the file is not found, use the global default
const fallbackConfig = path.join(__dirname, "default-config.yaml");

const finalConfig = fs.existsSync(configFullPath)
  ? configFullPath
  : fallbackConfig;

if (finalConfig === fallbackConfig) {
  if (debugMode)
    logger(
      `⚠️ Config file not found at ${configFullPath}. Using default configuration.`,
    );
  else logger(`⚠️ Config file not found. Using default configuration.`);
} else {
  if (debugMode) logger(`🔍 Using configuration from ${configFullPath}`);
  else logger(`🔍 Using custom configuration`);
}

if (debugMode) {
  logger(`🌐 Starting connection monitoring in the background...`);
  logger(`🔍 Interval: ${interval} seconds`);
  logger(`🔍 Mode: ${mode}`);
  logger(`🔍 Using config full path: ${configFullPath}`);
  logger(`🔍 Using temp file path: ${tempFilePath}`);
  logger(`🔍 Using PID file path: ${pidFilePath}`);
  logger(`🔍 Using Cache path: ${runnerCachePath}`);
}

// Check for sudo permissions
let hasSudo = false;
try {
  execSync("sudo -n true", { stdio: "ignore" });
  hasSudo = true;
  if (debugMode) logger("✅ Sudo permissions detected.");
} catch {
  if (debugMode)
    logger("❌ Sudo permissions not detected. Some features may be limited.");
}

// Load the configuration file
let configData = {};
try {
  configData = yaml.load(fs.readFileSync(finalConfig, "utf8"));
  if (debugMode) {
    logger(`🔍 Loaded configuration from ${finalConfig}`);
    logger("🔍 Configuration Data:", JSON.stringify(configData, null, 2));
  }
} catch (error) {
  if (debugMode)
    logger(`❌ Failed to load configuration file: ${error.message}`);
  logger("❌ Skipping config file...");
}

// Spawn a detached background process with the correct path
const monitorPath = path.join(__dirname, "monitor", "index.js");
if (debugMode) logger(`🚀 Spawning monitor from path: ${monitorPath}`);

// Expand the CIDR ranges to full IP lists
const expandCIDR = (cidrList) => {
  const expandedList = [];
  if (Array.isArray(cidrList) && cidrList.length > 0) {
    cidrList.forEach((range) => {
      const cidr = new IPCIDR(range);

      if (cidr.address !== null) {
        const rangeIPs = cidr.toArray();
        if (rangeIPs) {
          rangeIPs.forEach((ip) => expandedList.push(ip));
        }
      } else if (debugMode) {
        logger(`❌ Invalid CIDR range: ${range}`);
      }
    });
  } else {
    if (debugMode) logger("⚠️ CIDR list is empty or not defined.");
  }
  return expandedList;
};

let allowListIPv4 = [];
let allowListIPv6 = [];
let allowListDomains = [];
let allowListProcesses = [];
let blockListIPv4 = [];
let blockListIPv6 = [];
let blockListDomains = [];
let blockListProcesses = [];

// Parse the configuration data
if (configData) {
  try {
    allowListIPv4 = JSON.stringify(expandCIDR(configData.allow?.ip4 || []));
    allowListIPv6 = JSON.stringify(expandCIDR(configData.allow?.ip6 || []));
    allowListDomains = JSON.stringify(configData.allow?.domain || []);
    allowListProcesses = JSON.stringify(configData.allow?.process || []);
    blockListIPv4 = JSON.stringify(expandCIDR(configData.block?.ip4 || []));
    blockListIPv6 = JSON.stringify(expandCIDR(configData.block?.ip6 || []));
    blockListDomains = JSON.stringify(configData.block?.domain || []);
    blockListProcesses = JSON.stringify(configData.block?.process || []);
  } catch (error) {
    if (debugMode)
      logger(`❌ Error parsing configuration data: ${error.message}`);
  }
}

if (debugMode) {
  logger(`🔍 Allowlist IPv4: ${allowListIPv4}`);
  logger(`🔍 Allowlist IPv6: ${allowListIPv6}`);
  logger(`🔍 Allowlist Domains: ${allowListDomains}`);
  logger(`🔍 Allowlist Processes: ${allowListProcesses}`);
  logger(`🔍 Blocklist IPv4: ${blockListIPv4}`);
  logger(`🔍 Blocklist IPv6: ${blockListIPv6}`);
  logger(`🔍 Blocklist Domains: ${blockListDomains}`);
  logger(`🔍 Blocklist Processes: ${blockListProcesses}`);
}

const envVars = {
  ALLOWLIST_IP4: allowListIPv4,
  ALLOWLIST_IP6: allowListIPv6,
  ALLOWLIST_DOMAINS: allowListDomains,
  ALLOWLIST_PROCESSES: allowListProcesses,
  BLOCKLIST_IP4: blockListIPv4,
  BLOCKLIST_IP6: blockListIPv6,
  BLOCKLIST_DOMAINS: blockListDomains,
  BLOCKLIST_PROCESSES: blockListProcesses,
  HAS_SUDO: hasSudo,
};

const monitorProcess = spawn("node", [monitorPath], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    GITHUB_WORKSPACE: fs.realpathSync(workspace),
    ...envVars,
  },
});

monitorProcess.unref();

// Write the PID to a file for post.js to clean up
fs.writeFileSync(pidFilePath, monitorProcess.pid.toString());
fs.writeFileSync(runnerCachePath, monitorProcess.pid.toString());
const fd = fs.openSync(pidFilePath, "r+");
fs.fsyncSync(fd); // Force write to disk
fs.closeSync(fd);

if (debugMode) logger(`📌 Monitoring started with PID ${monitorProcess.pid}`);

// Verify the PID file exists
if (fs.existsSync(pidFilePath)) {
  if (debugMode) {
    logger(`✅ PID file created successfully at ${pidFilePath}`);
    logger(`✅ Cached PID file created successfully at ${runnerCachePath}`);
  }
} else {
  logger(`❌ PID file is missing.`, "error");
}
