const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  loginUrl: 'https://app.sa.toasttab.com',
  itemLibraryUrl: 'https://app.sa.toasttab.com/XtraChefManagement/ProductCatalog/ProductCatalog',
  auditLogFile: 'audit-log.csv',
  recatLogFile: 'recat-log.csv',
  recatErrorFile: 'recat-errors.csv',
  delayBetweenItems: 2000,
  delayAfterAction: 1500,
};

// ============================================================
// CLI FLAGS
// ============================================================

const DRY_RUN = process.argv.includes('--dry-run');
const PAUSE_EACH = process.argv.includes('--pause');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1]);
  return 9999;
})();

// ============================================================
// CATEGORY MAPPING
// Edit these keyword lists to control recategorization.
// First match wins. Order matters.
// ============================================================

const CATEGORY_RULES = [
  {
    category: 'Cleaning Supplies',
    keywords: [
      'bleach', 'sanitizer', 'sanitize', 'disinfect', 'detergent',
      'soap', 'degreaser', 'cleaner', 'cleaning', 'rinse aid',
      'sponge', 'brush', 'mop', 'broom', 'scrub',
    ],
  },
  {
    category: 'Bar Supplies',
    keywords: [
      'cocktail napkin', 'bar napkin', 'stir stick', 'swizzle',
      'cocktail straw', 'bar towel', 'jigger', 'shaker',
      'coaster', 'toothpick', 'cocktail pick', 'bar pick',
      'bar mat', 'pour spout', 'speed pour',
    ],
  },
  {
    category: 'Non-Food Items',
    keywords: [
      'toilet paper', 'paper towel', 'napkin', 'glove', 'nitrile',
      'trash bag', 'garbage bag', 'aluminum foil', 'foil wrap',
      'plastic wrap', 'cling film', 'cling wrap', 'saran',
      'chopstick', 'waribashi', 'straw', 'to-go', 'togo',
      'takeout', 'take out', 'to go container', 'togo container',
      'deli container', 'soup container', 'food container',
      'lid', 'cup sleeve', 'paper cup', 'plastic cup',
      'apron', 'towel', 'paper bag', 'plastic bag',
      'to go box', 'togo box', 'takeout box',
      'paper plate', 'foam plate', 'plastic plate',
      'paper bowl', 'foam bowl', 'plastic bowl',
      'utensil', 'plastic fork', 'plastic spoon', 'plastic knife',
      'purchase summary', 'delivery fee', 'fuel surcharge',
    ],
  },
];

// Default: if no rule matches, keep as Food Purchases (no change needed)
const DEFAULT_CATEGORY = 'Food Purchases';

// ============================================================
// DETERMINE TARGET CATEGORY
// ============================================================

function determineCategory(itemDescription) {
  const lower = (itemDescription || '').toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) {
        return { category: rule.category, matchedKeyword: kw };
      }
    }
  }
  return { category: DEFAULT_CATEGORY, matchedKeyword: null };
}

// ============================================================
// PARSE AUDIT LOG CSV
// ============================================================

function parseAuditLog(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`  Audit log not found: ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    console.log('  Audit log is empty (header only).');
    return [];
  }

  // Skip header
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    // CSV parsing: handle quoted fields
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current.trim());

    // Fields: Timestamp, Item, Vendor, Product, Category, GL_Code, Family_Unit, Status, Notes
    if (fields.length >= 8) {
      const item = {
        timestamp: fields[0],
        description: fields[1],
        vendor: fields[2],
        product: fields[3],
        currentCategory: fields[4],
        glCode: fields[5],
        familyUnit: fields[6],
        status: fields[7],
        notes: fields[8] || '',
      };

      // Only include approved items that are currently "Food Purchases"
      if (item.status === 'APPROVED' && item.currentCategory === 'Food Purchases') {
        const result = determineCategory(item.description);
        if (result.category !== DEFAULT_CATEGORY) {
          item.targetCategory = result.category;
          item.matchedKeyword = result.matchedKeyword;
          items.push(item);
        }
      }
    }
  }

  return items;
}

// ============================================================
// LOGGING
// ============================================================

function initLogs() {
  const header = 'Timestamp,Item,Vendor,Old_Category,New_Category,Matched_Keyword,Status,Notes\n';
  if (!fs.existsSync(CONFIG.recatLogFile)) {
    fs.writeFileSync(CONFIG.recatLogFile, header);
  }
  if (!fs.existsSync(CONFIG.recatErrorFile)) {
    fs.writeFileSync(CONFIG.recatErrorFile, header);
  }
}

function logRecat(file, data) {
  const line = [
    new Date().toISOString(),
    `"${(data.item || '').replace(/"/g, '""')}"`,
    `"${(data.vendor || '').replace(/"/g, '""')}"`,
    `"${(data.oldCategory || '').replace(/"/g, '""')}"`,
    `"${(data.newCategory || '').replace(/"/g, '""')}"`,
    `"${(data.matchedKeyword || '').replace(/"/g, '""')}"`,
    `"${(data.status || '').replace(/"/g, '""')}"`,
    `"${(data.notes || '').replace(/"/g, '""')}"`,
  ].join(',') + '\n';
  fs.appendFileSync(file, line);
}

// ============================================================
// HELPERS
// ============================================================

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// SEARCH FOR ITEM IN LIBRARY
// ============================================================

async function searchForItem(page, itemDescription) {
  // Clear any existing search
  const searchInput = await page.$('input[placeholder*="Search"]');
  if (!searchInput) {
    console.log('  >> Search input not found');
    return false;
  }

  // Clear and type the search term (use first 20 chars to avoid truncation issues)
  const searchTerm = itemDescription.substring(0, 20).trim();
  await searchInput.click({ clickCount: 3 });
  await searchInput.type(searchTerm, { delay: 30 });
  await delay(2000);

  // Click the matching row
  const clicked = await page.evaluate((desc) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    // Try exact match first
    let row = rows.find(r => {
      const cells = r.querySelectorAll('td');
      for (const cell of cells) {
        if (cell.textContent.trim() === desc) return true;
      }
      return false;
    });
    // Try partial match
    if (!row) {
      row = rows.find(r => r.textContent.includes(desc.substring(0, 15)));
    }
    if (row) {
      row.click();
      return true;
    }
    return false;
  }, itemDescription);

  if (clicked) {
    await delay(3000);
    return true;
  }

  return false;
}

// ============================================================
// SET CATEGORY ON ITEM DETAIL PAGE
// ============================================================

async function setCategoryOnPage(page, categoryName) {
  // Click the category dropdown
  const catExists = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => {
        const hint = b.getAttribute('hint') || '';
        const ariaLabel = b.getAttribute('aria-label') || '';
        return hint.toLowerCase().includes('category') || ariaLabel.toLowerCase().includes('category');
      });
    return !!btn;
  });

  if (!catExists) {
    // Try select dropdown
    const selectExists = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.some(s => {
        const id = (s.id || '').toLowerCase();
        const name = (s.name || '').toLowerCase();
        return id.includes('category') || name.includes('category');
      });
    });

    if (!selectExists) {
      console.log('  >> Category dropdown not found');
      return false;
    }

    // Use native select
    const result = await page.evaluate((name) => {
      const selects = Array.from(document.querySelectorAll('select'));
      const sel = selects.find(s => {
        const id = (s.id || '').toLowerCase();
        const n = (s.name || '').toLowerCase();
        return id.includes('category') || n.includes('category');
      });
      if (!sel) return { found: false };
      const options = Array.from(sel.options);
      const match = options.find(o => o.text.toLowerCase() === name.toLowerCase());
      if (match) {
        sel.value = match.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, set: true };
      }
      const available = options.map(o => o.text).filter(t => t).join(', ');
      return { found: true, set: false, available };
    }, categoryName);

    if (result.set) {
      await delay(500);
      return true;
    }
    if (result.found && !result.set) {
      console.log(`  >> Category "${categoryName}" not in select. Available: ${result.available}`);
    }
    return false;
  }

  // Use combobox
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => {
        const hint = b.getAttribute('hint') || '';
        const ariaLabel = b.getAttribute('aria-label') || '';
        return hint.toLowerCase().includes('category') || ariaLabel.toLowerCase().includes('category');
      });
    if (btn) btn.click();
  });
  await delay(800);

  // Search for the category
  const searchInput = await page.$('input[placeholder="Search..."]');
  if (searchInput) {
    await searchInput.type(categoryName.substring(0, 6), { delay: 50 });
    await delay(800);
  }

  const optionClicked = await page.evaluate((name) => {
    const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"]'));
    const match = options.find(o => o.textContent.trim().toLowerCase().includes(name.toLowerCase()));
    if (match) {
      match.click();
      return { clicked: true };
    }
    const available = options.map(o => o.textContent.trim()).slice(0, 15).join(', ');
    return { clicked: false, available };
  }, categoryName);

  if (optionClicked.clicked) {
    await delay(CONFIG.delayAfterAction);
    return true;
  }

  console.log(`  >> Category "${categoryName}" not found. Available: ${optionClicked.available}`);
  await page.keyboard.press('Escape');
  await delay(300);
  return false;
}

// ============================================================
// SAVE ITEM
// ============================================================

async function clickSave(page) {
  const saved = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => {
      const text = b.textContent.trim();
      return text === 'Save' || text === 'Save Changes';
    });
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (saved) {
    console.log('  >> Saved');
    await delay(2000);
    return true;
  }
  console.log('  >> Save button not found');
  return false;
}

// ============================================================
// CLOSE ITEM DETAIL (go back to list)
// ============================================================

async function closeItemDetail(page) {
  // Click the X button or back arrow
  const closed = await page.evaluate(() => {
    // Try close button (X)
    const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="close"]');
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    // Try any X-like button in the header area
    const buttons = Array.from(document.querySelectorAll('button'));
    const xBtn = buttons.find(b => {
      const text = b.textContent.trim();
      return text === '×' || text === 'X' || text === 'close' || text === '✕';
    });
    if (xBtn) {
      xBtn.click();
      return true;
    }
    return false;
  });

  if (closed) {
    await delay(2000);
    return true;
  }

  // Try clicking the back arrow
  const backed = await page.evaluate(() => {
    const arrows = Array.from(document.querySelectorAll('button, a'));
    const back = arrows.find(a => {
      const label = (a.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('back') || label.includes('close');
    });
    if (back) {
      back.click();
      return true;
    }
    return false;
  });

  if (backed) {
    await delay(2000);
    return true;
  }

  // Navigate directly back to item library
  await page.goto(CONFIG.itemLibraryUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);
  return true;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('==============================================');
  console.log('  xtraCHEF Category Cleanup v1.0');
  console.log('  Recategorize items from audit log');
  console.log('==============================================');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (preview only)' : 'LIVE (will update categories)'}`);
  console.log(`  Limit: ${LIMIT} items`);
  console.log(`  Pause: ${PAUSE_EACH ? 'Yes' : 'No'}`);
  console.log('==============================================\n');

  // Parse audit log and find items that need recategorization
  console.log('Reading audit log...');
  const itemsToRecat = parseAuditLog(CONFIG.auditLogFile);

  if (itemsToRecat.length === 0) {
    console.log('\nNo items need recategorization. Everything is already correct.');
    console.log('(Only items with status APPROVED and category "Food Purchases" that match');
    console.log(' a non-food keyword rule will be recategorized.)\n');
    return;
  }

  console.log(`\nFound ${itemsToRecat.length} items to recategorize:\n`);

  // Show preview
  const categoryGroups = {};
  for (const item of itemsToRecat) {
    if (!categoryGroups[item.targetCategory]) categoryGroups[item.targetCategory] = [];
    categoryGroups[item.targetCategory].push(item);
  }

  for (const [cat, items] of Object.entries(categoryGroups)) {
    console.log(`  ${cat} (${items.length} items):`);
    for (const item of items.slice(0, 5)) {
      console.log(`    - ${item.description} [matched: "${item.matchedKeyword}"]`);
    }
    if (items.length > 5) {
      console.log(`    ... and ${items.length - 5} more`);
    }
    console.log('');
  }

  if (DRY_RUN) {
    console.log('DRY RUN complete. No changes made.');
    console.log('Run without --dry-run to apply changes.\n');
    return;
  }

  initLogs();

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });

  let page = await browser.newPage();
  page.setDefaultTimeout(15000);

  console.log('Opening xtraCHEF login page...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  console.log('\n========================================');
  console.log('  LOG IN MANUALLY NOW');
  console.log('  1. Complete the Cloudflare challenge');
  console.log('  2. Enter your email and password');
  console.log('  3. Complete MFA if prompted');
  console.log('  4. Wait until the dashboard loads');
  console.log('========================================\n');

  await waitForEnter('Press ENTER when you are logged in and see the dashboard... ');

  console.log('\nNavigating to Item Library...');
  await page.goto(CONFIG.itemLibraryUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  console.log('\n========================================');
  console.log(`  READY TO RECATEGORIZE ${Math.min(itemsToRecat.length, LIMIT)} ITEMS`);
  console.log('  Press ENTER to start, or Ctrl+C to abort.');
  console.log('========================================\n');
  await waitForEnter('Press ENTER to begin... ');

  let processed = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < Math.min(itemsToRecat.length, LIMIT); i++) {
    const item = itemsToRecat[i];
    processed++;

    console.log(`\n--- ${processed}/${Math.min(itemsToRecat.length, LIMIT)} ---`);
    console.log(`  Item:     ${item.description}`);
    console.log(`  Vendor:   ${item.vendor}`);
    console.log(`  Current:  ${item.currentCategory}`);
    console.log(`  Target:   ${item.targetCategory} [keyword: "${item.matchedKeyword}"]`);

    try {
      // Make sure we're on the item library page
      const currentUrl = page.url();
      if (!currentUrl.includes('ProductCatalog')) {
        await page.goto(CONFIG.itemLibraryUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
      }

      // Search for the item
      console.log(`  >> Searching for item...`);
      const found = await searchForItem(page, item.description);

      if (!found) {
        console.log(`  >> NOT FOUND in library. Skipping.`);
        notFound++;
        logRecat(CONFIG.recatErrorFile, {
          item: item.description,
          vendor: item.vendor,
          oldCategory: item.currentCategory,
          newCategory: item.targetCategory,
          matchedKeyword: item.matchedKeyword,
          status: 'NOT_FOUND',
          notes: 'Item not found in library search',
        });

        // Clear search
        const searchInput = await page.$('input[placeholder*="Search"]');
        if (searchInput) {
          await searchInput.click({ clickCount: 3 });
          await searchInput.type(' ', { delay: 30 });
          await page.keyboard.press('Backspace');
          await delay(1000);
        }
        continue;
      }

      // Verify we're on the right item
      const pageDesc = await page.evaluate(() => {
        const descEl = document.getElementById('item_description');
        return descEl ? descEl.value : '';
      });

      if (pageDesc && !pageDesc.toLowerCase().includes(item.description.substring(0, 10).toLowerCase())) {
        console.log(`  >> Wrong item loaded: "${pageDesc}". Skipping.`);
        notFound++;
        await closeItemDetail(page);
        continue;
      }

      // Set the new category
      console.log(`  >> Setting category to: ${item.targetCategory}`);
      const catSet = await setCategoryOnPage(page, item.targetCategory);

      if (!catSet) {
        console.log(`  >> Could not set category. Skipping.`);
        errors++;
        logRecat(CONFIG.recatErrorFile, {
          item: item.description,
          vendor: item.vendor,
          oldCategory: item.currentCategory,
          newCategory: item.targetCategory,
          matchedKeyword: item.matchedKeyword,
          status: 'CAT_NOT_SET',
          notes: 'Category dropdown option not found',
        });
        await closeItemDetail(page);
        continue;
      }

      // Save
      await clickSave(page);

      console.log(`  >> UPDATED: ${item.currentCategory} -> ${item.targetCategory}`);
      updated++;
      logRecat(CONFIG.recatLogFile, {
        item: item.description,
        vendor: item.vendor,
        oldCategory: item.currentCategory,
        newCategory: item.targetCategory,
        matchedKeyword: item.matchedKeyword,
        status: 'UPDATED',
        notes: '',
      });

      // Go back to item library
      await closeItemDetail(page);

    } catch (error) {
      console.log(`  >> ERROR: ${error.message.substring(0, 80)}`);
      errors++;
      logRecat(CONFIG.recatErrorFile, {
        item: item.description,
        vendor: item.vendor,
        oldCategory: item.currentCategory,
        newCategory: item.targetCategory,
        matchedKeyword: item.matchedKeyword,
        status: 'ERROR',
        notes: error.message.substring(0, 100),
      });

      // Try to recover
      try {
        await page.goto(CONFIG.itemLibraryUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
      } catch (e) {
        const pages = await browser.pages();
        page = pages.find(p => p.url().includes('toasttab.com')) || pages[pages.length - 1];
        await delay(3000);
      }
    }

    console.log(`\n  TOTALS: ${updated} updated | ${notFound} not found | ${errors} errors | ${processed} processed`);

    if (PAUSE_EACH) {
      await waitForEnter('  Press ENTER for next item (Ctrl+C to stop)... ');
    }

    await delay(CONFIG.delayBetweenItems);
  }

  console.log('\n==============================================');
  console.log('  RECATEGORIZATION COMPLETE');
  console.log(`  Total processed: ${processed}`);
  console.log(`  Updated:         ${updated}`);
  console.log(`  Not found:       ${notFound}`);
  console.log(`  Errors:          ${errors}`);
  console.log(`  Log:             ${CONFIG.recatLogFile}`);
  console.log(`  Errors log:      ${CONFIG.recatErrorFile}`);
  console.log('==============================================\n');

  await waitForEnter('Press ENTER to close the browser... ');
  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
