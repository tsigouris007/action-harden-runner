const fs = require("fs");
const path = require("path");
const { Table } = require("console-table-printer");

const runnerCachePath = path.join(
  "/home/runner/work/_temp",
  "harden-runner.log",
);

// Simple mutex for synchronized access
let isWriting = false;
const queue = [];

// Used for the detached process since it cannot print to stdout
const processQueue = () => {
  if (queue.length === 0 || isWriting) return;

  isWriting = true;
  const { message, callback } = queue.shift();

  fs.appendFile(runnerCachePath, message, (err) => {
    isWriting = false;
    if (err) {
      console.error(`❌ Failed to write to log file: ${err.message}`);
    }
    callback?.();
    processQueue();
  });
};

// Writes logs to our file
const logger = (message, type = "info", fileOutput = false, flush = false) => {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;

  if (type === "info") console.log(formattedMessage);
  else if (type === "error") console.error(formattedMessage);
  else if (type === "warn") console.warn(formattedMessage);
  else if (type === "debug") console.debug(formattedMessage);
  else console.log(formattedMessage);

  if (fileOutput) {
    // Add the message to the queue for synchronized writing
    queue.push({ message: `${formattedMessage}\n` });
    processQueue();
  }

  if (flush) {
    process.stdout.write("", () => {});
    process.stderr.write("", () => {});
  }
};

// Format iptables and ip6tables output
const formatIptablesOutput = (rawOutput) => {
  const lines = rawOutput.split("\n");
  const tables = {};
  let currentChain = null;

  for (const line of lines) {
    if (line.startsWith("Chain")) {
      const [_, chain, policy, packets, bytes] = line.split(/\s+/);
      currentChain = chain;
      tables[currentChain] = [];
    } else if (line.trim() && currentChain && !line.startsWith("pkts")) {
      const [pkts, bytes, target, prot, opt, _in, out, source, destination] =
        line.trim().split(/\s+/);
      tables[currentChain].push({
        Packets: pkts,
        Bytes: bytes,
        Target: target,
        Protocol: prot,
        Opt: opt,
        In: _in,
        Out: out,
        Source: source,
        Destination: destination,
      });
    }
  }

  return tables;
};

// Display formatted tables
const displayTables = (tables, title) => {
  logger(`\n🔍 ${title}`);
  for (const [chain, rules] of Object.entries(tables)) {
    logger(`\n📌 Chain: ${chain}`);

    const p = new Table({
      columns: [
        { name: "Packets", alignment: "right" },
        { name: "Bytes", alignment: "right" },
        { name: "Target", alignment: "left" },
        { name: "Protocol", alignment: "left" },
        { name: "Opt", alignment: "left" },
        { name: "In", alignment: "left" },
        { name: "Out", alignment: "left" },
        { name: "Source", alignment: "left" },
        { name: "Destination", alignment: "left" },
      ],
    });

    rules.forEach((rule) => p.addRow(rule));
    const tableOutput = p.render();
    logger(`\n${tableOutput}`);
  }
};

// Returns empty string instead of null or undefined values
function cleanupJson(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Filters unique rows
function getUniqueRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const serializedRow = JSON.stringify(row);
    if (seen.has(serializedRow)) {
      return false; // Duplicate row, skip it
    }
    seen.add(serializedRow);
    return true; // Unique row, include it
  });
}

module.exports = {
  logger,
  formatIptablesOutput,
  displayTables,
  cleanupJson,
  getUniqueRows,
};
