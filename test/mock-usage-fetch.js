import fs from "node:fs/promises";

globalThis.fetch = async (_url, options = {}) => {
  const accountId = options?.headers?.["ChatGPT-Account-Id"] ?? "";
  const logPath = process.env.CX_TEST_USAGE_FETCH_LOG;
  if (logPath) {
    await fs.appendFile(logPath, `${accountId}\n`, "utf8");
  }

  const body = process.env.CX_TEST_USAGE_FETCH_RESPONSE ?? JSON.stringify({
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 9999999999 },
      secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 9999999999 }
    }
  });
  const status = Number.parseInt(process.env.CX_TEST_USAGE_FETCH_STATUS ?? "200", 10);

  return new Response(body, {
    status: Number.isFinite(status) ? status : 200,
    headers: { "content-type": "application/json" }
  });
};
