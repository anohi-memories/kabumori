// Static public pages for Kabumori (App Store review: privacy, terms, support, account deletion).
//
// Deliberately framework-free: five short pages do not justify a web framework, and a plain
// template + copy step builds identically on Netlify and locally with nothing to install.
//
// Values that only the operator can decide (operator name, contact address, effective date) are
// never written into the templates. They come from the environment at build time. A production
// build refuses to run while any of them is missing, so a page can never be published with a
// placeholder in it; a preview build renders the gap visibly and marks every page as a preview.
//
//   node build.mjs                 # preview build into ./dist
//   node build.mjs --production    # also implied by Netlify's CONTEXT=production
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The single list of public routes. The native app's links are derived from the same paths
// (src/lib/legal-links.ts), and a test checks the two stay in step.
export const PAGES = [
  { route: '/', source: 'index.html', title: 'かぶモリ' },
  { route: '/privacy', source: 'privacy.html', title: 'プライバシーポリシー' },
  { route: '/terms', source: 'terms.html', title: '利用規約' },
  { route: '/support', source: 'support.html', title: 'サポート・お問い合わせ' },
  { route: '/account-deletion', source: 'account-deletion.html', title: 'アカウントとデータの削除' },
];

export const REQUIRED_VALUES = [
  { key: 'KABUMORI_OPERATOR_NAME', token: 'OPERATOR_NAME', label: '運営者名' },
  { key: 'KABUMORI_SUPPORT_EMAIL', token: 'SUPPORT_EMAIL', label: 'お問い合わせ先メールアドレス' },
  { key: 'KABUMORI_POLICY_EFFECTIVE_DATE', token: 'EFFECTIVE_DATE', label: '制定日' },
];

const escapeHtml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function validValue(key, raw) {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (key === 'KABUMORI_SUPPORT_EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  if (key === 'KABUMORI_POLICY_EFFECTIVE_DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

/** Resolves every required value, or returns the list of missing ones. */
export function resolveValues(env) {
  const values = {};
  const missing = [];
  for (const { key, token, label } of REQUIRED_VALUES) {
    const value = validValue(key, env[key]);
    if (value) values[token] = value;
    else missing.push({ key, label });
  }
  return { values, missing };
}

function render(template, values, preview) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, token) => {
    if (token === 'SUPPORT_EMAIL' && values.SUPPORT_EMAIL) {
      const email = escapeHtml(values.SUPPORT_EMAIL);
      return `<a href="mailto:${email}">${email}</a>`;
    }
    if (values[token]) return escapeHtml(values[token]);
    const label = REQUIRED_VALUES.find((item) => item.token === token)?.label;
    if (!label) throw new Error(`Unknown template token {{${token}}}`);
    if (!preview) throw new Error(`Missing value for {{${token}}}`);
    return `<mark class="unset">【未設定：${label}】</mark>`;
  });
}

export function buildSite({ outDir, env, production }) {
  const { values, missing } = resolveValues(env);
  if (production && missing.length) {
    const names = missing.map((item) => item.key).join(', ');
    throw new Error(`Production build refused: set ${names}`);
  }
  const preview = !production;
  const layout = readFileSync(join(here, 'layout.html'), 'utf8');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(here, 'styles.css'), join(outDir, 'styles.css'));

  const written = [];
  for (const page of PAGES) {
    const body = readFileSync(join(here, 'pages', page.source), 'utf8');
    const html = render(
      layout
        .replace('{{PAGE_TITLE}}', escapeHtml(page.title))
        .replace('{{PREVIEW_BANNER}}', preview
          ? '<p class="preview-banner">プレビュー版です。公開前の内容を含みます。</p>'
          : '')
        .replace('{{ROBOTS}}', preview ? 'noindex, nofollow' : 'index, follow')
        .replace('{{BODY}}', body),
      values,
      preview,
    );
    const target = page.route === '/'
      ? join(outDir, 'index.html')
      : join(outDir, page.route.slice(1), 'index.html');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    written.push(page.route);
  }
  return { routes: written, missing: missing.map((item) => item.key), preview };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const production = process.argv.includes('--production') || process.env.CONTEXT === 'production';
  try {
    const result = buildSite({ outDir: join(here, 'dist'), env: process.env, production });
    console.log(`Built ${result.routes.length} pages (${result.preview ? 'preview' : 'production'}).`);
    if (result.missing.length) console.log(`Unset (shown as 未設定): ${result.missing.join(', ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
