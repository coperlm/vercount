import { NextRequest } from "next/server";
import { headers } from "next/headers";
import kv from "@/lib/kv";
import logger from "@/lib/logger";
import { successResponse, errorResponse, ApiErrors } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";

function parseDateInput(input?: string | null) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d;
}

function formatDate(d: Date) {
  // Convert to local date (YYYY-MM-DD) in server timezone
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDatesBetween(start: Date, end: Date) {
  const dates: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    dates.push(formatDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

export async function GET(req: NextRequest) {
  // Rate limit check
  const rateLimitResult = await checkRateLimit(req);
  if (!rateLimitResult.success) {
    return errorResponse(rateLimitResult.error || "Rate limit exceeded", 429);
  }

  const urlObj = new URL(req.url);
  const targetUrl = urlObj.searchParams.get("url");
  const startParam = urlObj.searchParams.get("start");
  const endParam = urlObj.searchParams.get("end");
  const type = urlObj.searchParams.get("type") || "page"; // 'page' | 'site' | 'both'

  if (!targetUrl) return ApiErrors.badRequest("Missing url parameter");

  try {
    const parsed = new URL(targetUrl);
    if (!parsed.protocol.startsWith("http") || !parsed.host) {
      return successResponse({ dates: [], series: {} }, "Invalid URL", 200);
    }

    const host = parsed.host;
    const path = parsed.pathname.replace(/\/index$/, "");

    // Determine date range
    const endDate = parseDateInput(endParam) || new Date();
    const startDate = parseDateInput(startParam) || new Date(Date.now() - 1000 * 60 * 60 * 24 * 29); // default 30 days

    if (startDate > endDate) return ApiErrors.badRequest("start must be before end");

    const dates = getDatesBetween(startDate, endDate);

    // For each date fetch the daily PV/UV values
    const results = await Promise.all(dates.map(async (d) => {
      const keys: Array<Promise<any>> = [];
      if (type === "page" || type === "both") {
        const pagePvKey = `pv:page:${host}:${path}:${d}`;
        const pageUvKey = `uv:page:${host}:${path}:${d}`;
        keys.push(kv.get(pagePvKey));
        keys.push(kv.scard(pageUvKey));
      }
      if (type === "site" || type === "both") {
        const sitePvKey = `pv:site:${host}:${d}`;
        const siteUvKey = `uv:site:${host}:${d}`;
        keys.push(kv.get(sitePvKey));
        keys.push(kv.scard(siteUvKey));
      }
      const vals = await Promise.all(keys);
      return vals.map(v => Number(v || 0));
    }));

    // Build series arrays
    const series: any = {};
    for (let i = 0; i < dates.length; i++) {
      let idx = 0;
      if (type === "page" || type === "both") {
        series.page_pv = series.page_pv || [];
        series.page_uv = series.page_uv || [];
        series.page_pv.push(results[i][idx++] || 0);
        series.page_uv.push(results[i][idx++] || 0);
      }
      if (type === "site" || type === "both") {
        series.site_pv = series.site_pv || [];
        series.site_uv = series.site_uv || [];
        series.site_pv.push(results[i][idx++] || 0);
        series.site_uv.push(results[i][idx++] || 0);
      }
    }

    logger.debug(`Returning stats for ${host}${path} from ${formatDate(startDate)} to ${formatDate(endDate)}`);
    return successResponse({ dates, series }, "OK");
  } catch (error) {
    logger.warn(`Invalid URL format: ${targetUrl}`, { error });
    return ApiErrors.badRequest("Invalid URL format");
  }
}
