import { NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db } from "@/db";
import { domains } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import kv from "@/lib/kv";
import logger from "@/lib/logger";
import { successResponse, ApiErrors } from "@/lib/api-response";

function parseDateInput(input?: string | null) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d;
}

function formatDate(d: Date) {
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

function csvEscape(field: string | number) {
  const s = String(field ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession();
    if (!session || !session.user) return ApiErrors.unauthorized();

    const userId = session.user.id;
    if (!userId) return ApiErrors.badRequest("User ID not found in session");

    const url = new URL(req.url);
    const domainName = url.searchParams.get('domain');
    const startParam = url.searchParams.get('start');
    const endParam = url.searchParams.get('end');

    if (!domainName) return ApiErrors.badRequest('domain is required');

    // Verify domain belongs to user
    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.name, domainName), eq(domains.userId, userId)),
    });
    if (!domain) return ApiErrors.notFound('Domain not found or does not belong to you');

    // Determine date range
    const endDate = parseDateInput(endParam) || new Date();
    const startDate = parseDateInput(startParam) || new Date(Date.now() - 1000 * 60 * 60 * 24 * 29);
    if (startDate > endDate) return ApiErrors.badRequest('start must be before end');

    const dates = getDatesBetween(startDate, endDate);

    // Fetch all page keys and filter out per-day keys
    const normalizedDomain = domain.name;
    const prefix = `pv:page:${normalizedDomain}:`;
    const keys = await kv.keys(`${prefix}*`);

    // Filter: exclude keys that end with a date like :YYYY-MM-DD
    const pageKeys = (keys || []).filter((k: string) => {
      return !/:\d{4}-\d{2}-\d{2}$/.test(k);
    });

    const paths = pageKeys.map((k: string) => k.substring(prefix.length));

    // If no pages, return an informative CSV header only
    if (paths.length === 0) {
      const header = ['path'];
      dates.forEach(d => {
        header.push(`${d} PV`);
        header.push(`${d} UV`);
      });
      const csv = header.join(',') + '\n';
      const filename = `export-${normalizedDomain}-${formatDate(startDate)}-${formatDate(endDate)}.csv`;
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // Build pipeline to fetch pv (get) and uv (scard) for each path x date
    const pipeline = kv.pipeline();
    for (const d of dates) {
      for (const p of paths) {
        pipeline.get(`pv:page:${normalizedDomain}:${p}:${d}`);
        pipeline.scard(`uv:page:${normalizedDomain}:${p}:${d}`);
      }
    }

    const rawResults = await pipeline.exec();

    // Normalize results into per-path arrays
    const perPath: { pv: number[]; uv: number[] }[] = paths.map(() => ({ pv: [], uv: [] }));
    let idx = 0;
    for (let di = 0; di < dates.length; di++) {
      for (let pi = 0; pi < paths.length; pi++) {
        const pvVal = rawResults[idx++] || 0;
        const uvVal = rawResults[idx++] || 0;
        perPath[pi].pv.push(Number(pvVal || 0));
        perPath[pi].uv.push(Number(uvVal || 0));
      }
    }

    // Build CSV
    const header = ['path'];
    dates.forEach(d => {
      header.push(`${d} PV`);
      header.push(`${d} UV`);
    });
    const rows: string[] = [];
    rows.push(header.join(','));

    for (let i = 0; i < paths.length; i++) {
      const row: string[] = [];
      row.push(csvEscape(paths[i]));
      for (let j = 0; j < dates.length; j++) {
        row.push(csvEscape(perPath[i].pv[j] ?? 0));
        row.push(csvEscape(perPath[i].uv[j] ?? 0));
      }
      rows.push(row.join(','));
    }

    const csv = rows.join('\n') + '\n';
    const filename = `export-${normalizedDomain}-${formatDate(startDate)}-${formatDate(endDate)}.csv`;

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    logger.error('Error in GET /api/domains/export', { error });
    return ApiErrors.internalError();
  }
}
