// src/monitor.js
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { logger } = require("./utils");
const dns = require("dns");

const interval = parseInt(process.env["INPUT_INTERVAL"] || 1);
const mode = process.env["INPUT_MODE"] || "log";
const block_na = process.env["INPUT_BLOCK_NA"] === "true";
const diskWriteInterval = 2; // Write to disk every 2 seconds
const workspace = process.env.GITHUB_WORKSPACE;
const debugMode = process.env["INPUT_DEBUG"] === "true";
const hasSudo = process.env.HAS_SUDO === "true";

// Load lists from environment variables
const allowlistIPv4 = JSON.parse(process.env.ALLOWLIST_IP4 || "[]");
const allowlistIPv6 = JSON.parse(process.env.ALLOWLIST_IP6 || "[]");
const allowlistDomains = new Set(
  JSON.parse(process.env.ALLOWLIST_DOMAINS || "[]"),
);
const allowlistProcesses = new Set(
  JSON.parse(process.env.ALLOWLIST_PROCESSES || "[]"),
);

const blocklistIPv4 = JSON.parse(process.env.BLOCKLIST_IP4 || "[]");
const blocklistIPv6 = JSON.parse(process.env.BLOCKLIST_IP6 || "[]");
const blocklistDomains = new Set(
  JSON.parse(process.env.BLOCKLIST_DOMAINS || "[]"),
);
const blocklistProcesses = new Set(
  JSON.parse(process.env.BLOCKLIST_PROCESSES || "[]"),
);

if (!workspace) {
  logger("❌ GITHUB_WORKSPACE is not set. Exiting.", "error", true);
  process.exit(1);
}

const absoluteWorkspace = fs.realpathSync(workspace);
const tempFilePath = path.join(
  absoluteWorkspace,
  "harden-runner-connections.json",
);

if (debugMode) {
  logger(
    `🌐 Monitoring connections every ${interval}s. Writing to ${tempFilePath} every ${diskWriteInterval}s`,
    "info",
    true,
  );
  logger(`🔍 Absolute workspace path: ${absoluteWorkspace}`, "info", true);
  logger(`🔍 Mode: ${mode}`, "info", true);
  logger(`🔍 Sudo: ${hasSudo}`, "info", true);
}

const connections = new Map();
const dnsCache = new Map();
let lastFlushTime = Date.now();

// Resolve domain names from IP addresses
const resolveDomain = (ip) => {
  return new Promise((resolve) => {
    if (dnsCache.has(ip)) {
      resolve(dnsCache.get(ip));
      return;
    }

    // First attempt
    dns.reverse(ip, (err, hostnames) => {
      if (err || hostnames.length === 0) {
        // Second attempt
        dns.lookupService(ip, 443, (err, hostname) => {
          if (err) {
            dnsCache.set(ip, ip); // Cache IP itself if no domain found
            resolve(ip);
          } else {
            dnsCache.set(ip, hostname);
            resolve(hostname);
          }
        });
      } else {
        const hostname = hostnames[0];
        dnsCache.set(ip, hostname);
        resolve(hostname);
      }
    });
  });
};

// Escape special characters in regex
const escapeRegex = (str) => {
  return str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
};

// Matches a domain against a wildcard pattern
const matchWildcard = (domain, domainSet) => {
  for (const pattern of domainSet) {
    // Convert wildcard pattern to RegExp
    // Escape dots and replace * with .* for wildcard matching
    const regexPattern =
      "^" + pattern.split("*").map(escapeRegex).join(".*") + "$";
    const regex = new RegExp(regexPattern);

    // If it matches, return true
    if (regex.test(domain)) return true;
  }
  return false;
};

const blockConnection = (ipAddress, ipv, pid) => {
  // Kill the process immediately if pid is available
  if (pid !== "N/A") {
    if (debugMode) logger(`🚫 Trying to kill process: ${pid}`, "info", true);
    try {
      if (hasSudo) {
        // Kill the process
        process.kill(pid, "SIGKILL");
        logger(
          `✅ Killed process ${pid} associated with ${ipv} address: ${ipAddress}`,
          "info",
          true,
        );
      } else {
        logger(
          `❌ Cannot kill process ${pid} - sudo permissions are missing.`,
          "error",
          true,
        );
      }
    } catch (error) {
      if (debugMode)
        logger(
          `❌ Failed to kill process ${pid}. This is not always an issue if the process has already terminated.`,
          "error",
          true,
        );
    }
  }

  // Block the connection
  if (debugMode)
    logger(`🚫 Trying to block ${ipv} address: ${ipAddress}`, "info", true);
  try {
    if (hasSudo) {
      let command;
      if (ipv === "IPv4")
        command = `sudo iptables -A OUTPUT -d ${ipAddress} -j DROP`;
      else if (ipv === "IPv6")
        command = `sudo ip6tables -A OUTPUT -d ${ipAddress} -j DROP`;
      else throw new Error(`Invalid IP version: ${ipv}`);
      if (command) {
        exec(command, (error, stdout, stderr) => {
          if (error) {
            if (debugMode) {
              logger(
                `❌ Failed to block ${ipAddress}: ${error.message}`,
                "error",
                true,
              );
              if (stderr) logger(`⚠️ Stderr: ${stderr}`, "warn", true);
            } else {
              logger(`❌ Failed to block ${ipAddress}.`, "error", true);
            }
          } else {
            logger(`✅ Blocked ${ipv} ${ipAddress}`, "info", true);
          }
        });
      }
    } else {
      logger(
        `❌ Cannot block ${ipAddress} - sudo permissions are missing.`,
        "error",
        true,
      );
    }
  } catch (error) {
    if (debugMode)
      logger(
        `❌ Failed to block ${ipAddress}: ${error.message}`,
        "error",
        true,
      );
  }
};

// Sets status based on allow/block lists
const checkStatus = (ipAddress, domain, process) => {
  if (blocklistIPv4.includes(ipAddress)) return "block";
  if (allowlistIPv4.includes(ipAddress)) return "allow";

  if (blocklistIPv6.includes(ipAddress)) return "block";
  if (allowlistIPv6.includes(ipAddress)) return "allow";

  if (matchWildcard(domain, blocklistDomains)) return "block";
  if (matchWildcard(domain, allowlistDomains)) return "allow";

  if (blocklistProcesses.has(process)) return "block";
  if (allowlistProcesses.has(process)) return "allow";

  if (block_na) return "block"; // N/A are blocked if block_na is true
  return "N/A";
};

// Monitoring function
const monitor = (command) => {
  exec(command, async (error, stdout, stderr) => {
    if (error) {
      if (debugMode) logger(`❌ Error: ${error.message}`, "error", true);
      else
        logger(
          `❌ Error occurred while executing monitoring command.`,
          "error",
          true,
        );
      return;
    }
    if (stderr) {
      if (debugMode) logger(`⚠️ Stderr: ${stderr}`, "warn", true);
      else
        logger(
          `⚠️ Stderr output detected while executing monitoring command.`,
          "warn",
          true,
        );
      return;
    }

    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length > 6) {
        const protocol = parts[0];
        const local = parts[3];
        const remote = parts[4];
        const state = parts[5];
        const pidInfo = parts[6];

        const [pid, process] = pidInfo.includes("/")
          ? pidInfo.split("/")
          : ["N/A", "N/A"];
        const connectionId = `${local}-${remote}`;

        let remote_ip, remote_port;

        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        const ipv6Regex = /^([a-fA-F0-9:]+:+)+[a-fA-F0-9]+$/;

        // Split IP and port
        const lastColon = remote.lastIndexOf(":");
        remote_ip = remote.slice(0, lastColon);
        remote_port = remote.slice(lastColon + 1);

        // Distinguish between IPv4 and IPv6
        if (ipv6Regex.test(remote_ip)) ipv = "IPv6";
        else if (ipv4Regex.test(remote_ip)) ipv = "IPv4";
        else {
          logger(`❌ Could not parse IP address: ${remote}`, "error", true);
          remote_ip = "N/A";
          remote_port = "N/A";
          ipv = "N/A";
        }

        // Perform domain resolution
        const resolvedDomain = await resolveDomain(remote_ip);

        // Check status against allow/block lists
        const status = checkStatus(remote_ip, resolvedDomain, process);

        // Block connection if necessary
        if (mode === "block" && status === "block")
          blockConnection(remote_ip, ipv, pid);

        connections.set(connectionId, {
          protocol: protocol,
          ipv: ipv,
          local_ip: local.split(":")[0],
          local_port: local.split(":")[1],
          remote_ip: remote_ip,
          remote_port: remote_port,
          pid: pid,
          process: process,
          domain: resolvedDomain,
          state: state,
          status: status,
        });
      }
    }

    // Write to disk every 2 seconds
    if (Date.now() - lastFlushTime >= diskWriteInterval * 1000) {
      const jsonArray = Array.from(connections.values());
      fs.writeFileSync(tempFilePath, JSON.stringify(jsonArray, null, 2));
      lastFlushTime = Date.now();
    }
  });
};

// Command to monitor connections
const command = hasSudo
  ? `sudo netstat -tunp | grep -E 'ESTABLISHED|CLOSE_WAIT|TIME_WAIT'`
  : `netstat -tunp | grep -E 'ESTABLISHED|CLOSE_WAIT|TIME_WAIT'`;

// Set interval for polling
setInterval(() => monitor(command), interval * 1000);
