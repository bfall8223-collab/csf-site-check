// City Shift Finance site check: headers, breadcrumbs, mobile menu.
// Runs as a logged-out visitor. Read-only: it never changes the site.
const { chromium, devices } = require('playwright');
const fs = require('fs');

const SITE = process.env.SITE || 'https://cityshiftfinance.com';
const LIMIT = parseInt(process.env.LIMIT || '0', 10);      // 0 = all pages
const ONLY = (process.env.ONLY || '').split(/\s+/).filter(Boolean); // optional URL list
const CONCURRENCY = 4;
const OUT = 'report';

async function getUrls(request) {
  if (ONLY.length) return ONLY;
  const seen = new Set(), urls = new Set();
  async function read(u) {
    if (seen.has(u)) return; seen.add(u);
    const r = await request.get(u, { timeout: 30000 });
    if (!r.ok()) return;
    const xml = await r.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m =>
