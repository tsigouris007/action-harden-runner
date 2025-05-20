// src/abusech.js
const https = require("https");
const { logger, cleanupJson } = require("./utils");
const debugMode = process.env["INPUT_DEBUG"] === "true";

function abuseSeverity(data) {
  const abuseConfidenceScore = parseInt(data.abuseConfidenceScore || 0, 10);
  const totalReports = parseInt(data.totalReports || 0, 10);
  const isTor = data.isTor === true;
  const lastReportedAt = data.lastReportedAt;
  const isWhitelisted = data.isWhitelisted === true;

  let score = 0;

  // Score mapping
  score += abuseConfidenceScore;
  score += totalReports * 0.5;

  if (isTor) score += 30;

  if (isWhitelisted) score -= 50;

  if (lastReportedAt) {
    const lastReportDate = new Date(lastReportedAt);
    const currentDate = new Date();
    const daysDifference = Math.floor(
      (currentDate - lastReportDate) / (1000 * 60 * 60 * 24),
    );
    if (daysDifference <= 30) score += 20;
  }

  if (score >= 90) return "🔴 Critical";
  else if (score >= 60) return "🟠 High";
  else if (score >= 30) return "🟡 Medium";
  else if (score >= 10) return "🔵 Low";
  else return "🟢 None";
}

function fetchAbuseCHData(ip, apiKey) {
  const options = {
    hostname: "api.abuseipdb.com",
    path: `/api/v2/check?ipAddress=${ip}&maxAgeInDays=30&verbose=true`,
    method: "GET",
    headers: {
      Accept: "application/json",
      Key: apiKey,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const json = JSON.parse(data);

          if (json.data) {
            if (debugMode) {
              logger(`✅ Data from AbuseCh for ${ip} retrieved.`);
              logger(JSON.stringify(json.data, null, 2));
            }
            json.data.severity = abuseSeverity(json.data);

            // Cleanup fields (remove null or undefined values)
            const cleanData = {};
            Object.keys(json.data).forEach((key) => {
              cleanData[key] = cleanupJson(json.data[key]);
            });

            resolve(cleanData);
          } else {
            logger(`❌ No data found for ${ip}.`);

            resolve({});
          }
        } catch (parseError) {
          if (debugMode)
            logger(`❌ Error parsing JSON response: ${parseError.message}`);

          resolve({});
        }
      });
    });

    req.on("error", (error) => {
      if (debugMode) console.error(`Request error: ${error.message}`);
      reject(error);
    });

    req.end();
  });
}

module.exports = { fetchAbuseCHData };
