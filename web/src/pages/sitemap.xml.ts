// /sitemap.xml: the static public pages plus every live listing, generated per
// request so it never rots. The XML builder stays single-source in the bot's
// src/site-shelf.ts (tested there).
import type { APIRoute } from "astro";
import { sitemapXml } from "../../../src/site-shelf.ts";
import { getCatalog, SHELF_CACHE } from "../lib/shelf";

export const prerender = false;

export const GET: APIRoute = async () => {
  const { listings } = await getCatalog();
  return new Response(sitemapXml(listings.map(l => ({ id: l.id, updatedAt: l.updatedAt }))), {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": SHELF_CACHE },
  });
};
