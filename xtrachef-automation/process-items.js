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
  defaultGLCode: '5000',       // Celestia default
  ishinGLCode: '5001',         // Ishin (Japanese fish)
  defaultCategory: 'Food Purchases',
  nonFoodCategory: 'Non-Food Items',
  auditLogFile: 'audit-log.csv',
  flaggedLogFile: 'flagged-items.csv',
  delayBetweenItems: 3000,     // ms to wait between items
  delayAfterAction: 1500,      // ms to wait after each action
  maxRetries: 5,
  maxItemsPerRun: 500,         // Safety cap per run
  maxWaitForNavigation: 15000, // max ms to wait for page to advance after approve
};

// ============================================================
// CLI FLAGS
// ============================================================

const DRY_RUN = process.argv.includes('--dry-run');
const PAUSE_EACH = process.argv.includes('--pause');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1]);
  return CONFIG.maxItemsPerRun;
})();

if (DRY_RUN) {
  console.log('\n  *** DRY RUN MODE ***');
  console.log('  No changes will be made. The script will read each item,');
  console.log('  show what it WOULD do, and move to the next item.\n');
}

if (PAUSE_EACH) {
  console.log('  *** PAUSE MODE: Will pause after each item for review ***\n');
}

console.log(`  Item limit this run: ${LIMIT}\n`);

// ============================================================
// JAPANESE VENDOR DETECTION
// ============================================================

const JAPANESE_VENDORS = [
  'east sea trading',
  'ohta foods',
  'true world foods',
  'atlanta mutual trading',
  'jfc',
];

const JAPANESE_FISH_KEYWORDS = [
  'madai', 'shima aji', 'kohada', 'hagatsuo', 'hamachi', 'hirame',
  'kanpachi', 'maguro', 'otoro', 'chutoro', 'akami', 'uni',
  'amaebi', 'botan ebi', 'ikura', 'anago', 'conger', 'engawa',
  'tai', 'buri', 'sake', 'saba', 'aji', 'iwashi', 'sanma',
  'sayori', 'suzuki', 'kinmedai', 'nodoguro', 'akamutsu',
  'mozuku', 'ooba', 'shiso', 'yuzu', 'wasabi', 'nori',
  'dashi', 'mirin', 'usukuchi', 'koikuchi',
];

// ============================================================
// NON-FOOD DETECTION
// ============================================================

const NON_FOOD_KEYWORDS = [
  'toilet paper', 'paper towel', 'napkin', 'glove', 'bleach',
  'sanitizer', 'detergent', 'soap', 'trash bag', 'garbage bag',
  'aluminum foil', 'plastic wrap', 'cling film', 'chopstick',
  'waribashi', 'coaster', 'drinking straw', 'paper straw',
  'to-go', 'togo', 'takeout', 'to go container', 'deli container',
  'apron', 'towel', 'sponge',
  'brush', 'mop', 'broom', 'rinse aid', 'degreaser',
  'purchase summary', 'delivery fee', 'fuel surcharge',
];

// ============================================================
// FAMILY UNIT LOGIC
// ============================================================

const VOLUME_KEYWORDS = [
  'oil', 'vinegar', 'sauce', 'syrup', 'juice', 'wine', 'sake',
  'mirin', 'soy', 'dressing', 'broth', 'stock', 'cream',
  'milk', 'water', 'beer', 'spirit', 'liquor', 'extract',
];

function determineFamilyUnit(itemDesc) {
  const lower = itemDesc.toLowerCase();
  for (const kw of VOLUME_KEYWORDS) {
    if (lower.includes(kw)) return 'Volume';
  }
  for (const kw of NON_FOOD_KEYWORDS) {
    if (lower.includes(kw)) return 'Each';
  }
  return 'Weight';
}

// ============================================================
// PRODUCT NAME CLEANING
// ============================================================

function cleanProductName(itemDesc) {
  let name = itemDesc
    .replace(/\*\*/g, '')
    .replace(/\*PACK\s*\d+CT\*/gi, '')
    .replace(/\d+[-]?LB/gi, '')
    .replace(/\d+[-]?OZ/gi, '')
    .replace(/\d+[-]?ML/gi, '')
    .replace(/\d+[-]?GAL/gi, '')
    .replace(/\d+[-]?CT/gi, '')
    .replace(/\bFF\b/gi, '')
    .replace(/\bFRZ\b/gi, '')
    .replace(/\bIQF\b/gi, '')
    .replace(/\bRAW\b/gi, '')
    .replace(/\bEACH\b/gi, '')
    .replace(/\bBKAN\b/gi, '')
    .replace(/\bARZRSVS\b/gi, '')
    .replace(/JF\s*\d+/gi, '')
    .replace(/\d{3,}/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  name = name.replace(/\b\w/g, c => c.toLowerCase());
  name = name.replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');

  return name || itemDesc.toLowerCase().substring(0, 40);
}

// ============================================================
// DETECTION FUNCTIONS
// ============================================================

function isJapaneseFish(vendor, itemDesc) {
  const lowerVendor = (vendor || '').toLowerCase();
  const lowerDesc = (itemDesc || '').toLowerCase();
  const isJapaneseVendor = JAPANESE_VENDORS.some(v => lowerVendor.includes(v));
  const hasJapaneseKeyword = JAPANESE_FISH_KEYWORDS.some(kw => lowerDesc.includes(kw));
  return isJapaneseVendor && hasJapaneseKeyword;
}

function isNonFood(itemDesc) {
  const lower = (itemDesc || '').toLowerCase();
  return NON_FOOD_KEYWORDS.some(kw => lower.includes(kw));
}

// ============================================================
// LOGGING
// ============================================================

function initAuditLog() {
  const header = 'Timestamp,Item,Vendor,Product,Category,GL_Code,Family_Unit,Status,Notes\n';
  if (!fs.existsSync(CONFIG.auditLogFile)) {
    fs.writeFileSync(CONFIG.auditLogFile, header);
  }
  if (!fs.existsSync(CONFIG.flaggedLogFile)) {
    fs.writeFileSync(CONFIG.flaggedLogFile, header);
  }
}

function logItem(file, data) {
  const line = [
    new Date().toISOString(),
    `"${(data.item || '').replace(/"/g, '""')}"`,
    `"${(data.vendor || '').replace(/"/g, '""')}"`,
    `"${(data.product || '').replace(/"/g, '""')}"`,
    `"${(data.category || '').replace(/"/g, '""')}"`,
    `"${(data.glCode || '').replace(/"/g, '""')}"`,
    `"${(data.familyUnit || '').replace(/"/g, '""')}"`,
    `"${(data.status || '').replace(/"/g, '""')}"`,
    `"${(data.notes || '').replace(/"/g, '""')}"`,
  ].join(',') + '\n';
  fs.appendFileSync(file, line);
}

// ============================================================
// HELPER: Wait for user input
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

// ============================================================
// HELPER: Delay
// ============================================================

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// HELPER: Get current item description from page
// ============================================================

async function getCurrentDescription(page) {
  return await page.evaluate(() => {
    const descEl = document.getElementById('item_description');
    return descEl ? descEl.value : '';
  });
}

// ============================================================
// HELPER: Get current item number from "Invoice item X of Y"
// ============================================================

async function getCurrentItemNumber(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/Invoice item (\d+) of (\d+)/);
    return match ? { current: parseInt(match[1]), total: parseInt(match[2]) } : { current: 0, total: 0 };
  });
}

// ============================================================
// HELPER: Wait for page to advance to a different item
// Returns true if the page changed, false if timed out
// ============================================================

async function waitForItemChange(page, previousDescription, previousItemNumber, maxWait) {
  const startTime = Date.now();
  const checkInterval = 500; // check every 500ms

  while (Date.now() - startTime < maxWait) {
    await delay(checkInterval);

    try {
      const currentDesc = await getCurrentDescription(page);
      const currentNum = await getCurrentItemNumber(page);

      // Check if description changed
      if (currentDesc && currentDesc !== previousDescription) {
        console.log(`  >> Page advanced (description changed)`);
        return true;
      }

      // Check if item number changed
      if (currentNum.current !== previousItemNumber && currentNum.current > 0) {
        console.log(`  >> Page advanced (item ${previousItemNumber} -> ${currentNum.current})`);
        return true;
      }

      // Check if "Review complete" dialog appeared (end of batch)
      const reviewComplete = await page.evaluate(() => {
        // Look for the specific dialog, not just any text on the page
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, [class*="modal"], [class*="dialog"]'));
        for (const d of dialogs) {
          if (d.textContent.includes('Review complete')) return true;
        }
        // Also check for a button that says "View item library" which appears in the completion dialog
        const btns = Array.from(document.querySelectorAll('button'));
        const viewLibBtn = btns.find(b => b.textContent.includes('View item library'));
        if (viewLibBtn && document.body.innerText.includes('Review complete')) return true;
        return false;
      });
      if (reviewComplete) {
        console.log(`  >> Batch complete dialog appeared`);
        return true;
      }
    } catch (e) {
      // Frame detached = page navigated/reloaded, which means it advanced
      if (e.message.includes('detached') || e.message.includes('Detached') || e.message.includes('destroyed') || e.message.includes('closed')) {
        console.log(`  >> Page reloaded (frame detached), waiting for new page...`);
        await delay(3000);
        return true;
      }
      // Other errors, keep waiting
      console.log(`  >> Check error: ${e.message.substring(0, 60)}, retrying...`);
    }
  }

  console.log(`  >> Timed out waiting for page to advance (${maxWait}ms)`);
  return false;
}

// ============================================================
// PAGE INTERACTION HELPERS
// ============================================================

async function setGLCode(page, value) {
  if (DRY_RUN) return;
  await page.evaluate((val) => {
    const glInput = document.getElementById('gl_code');
    if (glInput) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeInputValueSetter.call(glInput, val);
      glInput.dispatchEvent(new Event('input', { bubbles: true }));
      glInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, value);
  await delay(500);
}

// ============================================================
// SET SIZE FIELD
// ============================================================

async function setSizeField(page, value) {
  if (DRY_RUN) return true;

  const result = await page.evaluate((val) => {
    // Try by ID first
    let sizeInput = document.getElementById('size')
      || document.querySelector('input[name="size"]');

    // Try by label proximity
    if (!sizeInput) {
      const labels = Array.from(document.querySelectorAll('label, span, div'));
      for (const label of labels) {
        const text = label.textContent.trim().toLowerCase();
        if (text === 'size*' || text === 'size') {
          const container = label.closest('div');
          if (container) {
            const inp = container.querySelector('input[type="text"], input[type="number"], input:not([type])');
            if (inp) {
              sizeInput = inp;
              break;
            }
          }
        }
      }
    }

    if (!sizeInput) return { found: false };

    // Use native setter to trigger React state update
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(sizeInput, val);
    sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    sizeInput.dispatchEvent(new Event('change', { bubbles: true }));
    sizeInput.dispatchEvent(new Event('blur', { bubbles: true }));
    return { found: true, newValue: sizeInput.value };
  }, value);

  if (!result.found) {
    console.log('  >> Size field not found on page');
    return false;
  }

  await delay(500);
  console.log(`  >> Size set to: ${value}`);
  return true;
}

// ============================================================
// READ CURRENT ITEM
// ============================================================

async function readCurrentItem(page) {
  return await page.evaluate(() => {
    const descEl = document.getElementById('item_description');
    const glEl = document.getElementById('gl_code');

    const pageText = document.body.innerText;
    const vendorMatch = pageText.match(/Vendor:\s*(.+)/);

    const categoryBtn = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => {
        const hint = b.getAttribute('hint') || '';
        const ariaLabel = b.getAttribute('aria-label') || '';
        return hint.toLowerCase().includes('category') || ariaLabel.toLowerCase().includes('category');
      });

    const unitCombobox = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => {
        const hint = b.getAttribute('hint') || '';
        const ariaLabel = b.getAttribute('aria-label') || '';
        return (hint.toLowerCase() === 'unit' || ariaLabel.toLowerCase() === 'unit');
      });

    const allSelects = Array.from(document.querySelectorAll('select'));
    let unitSelect = null;
    let invUnitSelect = null;

    for (const sel of allSelects) {
      const id = (sel.id || '').toLowerCase();
      const name = (sel.name || '').toLowerCase();
      if (id.includes('unit') && !id.includes('inventory') && !id.includes('inv')) {
        unitSelect = sel;
      } else if (id.includes('inventory') || id.includes('inv_unit') || id.includes('invunit')) {
        invUnitSelect = sel;
      } else if (name.includes('unit') && !name.includes('inventory')) {
        unitSelect = sel;
      } else if (name.includes('inventory')) {
        invUnitSelect = sel;
      }
    }

    if (!unitSelect && !invUnitSelect && allSelects.length >= 2) {
      const allLabels = Array.from(document.querySelectorAll('label, span, div'));
      for (const label of allLabels) {
        const text = label.textContent.trim().toLowerCase();
        if (text === 'unit*' || text === 'unit') {
          const container = label.closest('div');
          if (container) {
            const sel = container.querySelector('select');
            if (sel) unitSelect = sel;
          }
        }
        if (text.includes('inventory unit') || text === 'inventory unit*') {
          const container = label.closest('div');
          if (container) {
            const sel = container.querySelector('select');
            if (sel) invUnitSelect = sel;
          }
        }
      }
    }

    const invUnitCombobox = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => {
        const hint = b.getAttribute('hint') || '';
        const ariaLabel = b.getAttribute('aria-label') || '';
        return hint.toLowerCase().includes('inventory') || ariaLabel.toLowerCase().includes('inventory');
      });

    let unitValue = '';
    let unitType = 'none';
    if (unitCombobox) {
      unitValue = unitCombobox.textContent.trim();
      unitType = 'combobox';
    } else if (unitSelect) {
      unitValue = unitSelect.options[unitSelect.selectedIndex]?.text || unitSelect.value || '';
      unitType = 'select';
    }

    let invUnitValue = '';
    let invUnitType = 'none';
    if (invUnitCombobox) {
      invUnitValue = invUnitCombobox.textContent.trim();
      invUnitType = 'combobox';
    } else if (invUnitSelect) {
      invUnitValue = invUnitSelect.options[invUnitSelect.selectedIndex]?.text || invUnitSelect.value || '';
      invUnitType = 'select';
    }

    // Read Size field
    const sizeInput = document.getElementById('size') 
      || document.querySelector('input[name="size"]')
      || (() => {
        const labels = Array.from(document.querySelectorAll('label, span, div'));
        for (const label of labels) {
          if (label.textContent.trim().toLowerCase() === 'size*' || label.textContent.trim().toLowerCase() === 'size') {
            const container = label.closest('div');
            if (container) {
              const inp = container.querySelector('input[type="text"], input[type="number"], input:not([type])');
              if (inp) return inp;
            }
          }
        }
        return null;
      })();
    const sizeValue = sizeInput ? sizeInput.value : '';

    const hasProduct = !!Array.from(document.querySelectorAll('span'))
      .find(s => s.textContent.trim() === 'View product');

    const navText = pageText.match(/Invoice item (\d+) of (\d+)/);

    const isApproved = !!Array.from(document.querySelectorAll('span'))
      .find(s => s.textContent.includes('APPROVED'));

    const checkWorkEl = Array.from(document.querySelectorAll('p, span, div'))
      .find(el => el.textContent.includes('Check your work'));
    const checkWork = checkWorkEl ? checkWorkEl.textContent.trim() : '';

    const comboboxDebug = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .map(b => `hint="${b.getAttribute('hint')}" aria="${b.getAttribute('aria-label')}" text="${b.textContent.trim().substring(0, 30)}"`)
      .join(' | ');

    const selectDebug = allSelects
      .map(s => `id="${s.id}" name="${s.name}" val="${s.value}"`)
      .join(' | ');

    return {
      description: descEl ? descEl.value : '',
      vendor: vendorMatch ? vendorMatch[1].trim() : '',
      glCode: glEl ? glEl.value : '',
      category: categoryBtn ? categoryBtn.textContent.trim() : '',
      unit: unitValue,
      unitType: unitType,
      inventoryUnit: invUnitValue,
      invUnitType: invUnitType,
      hasProduct: hasProduct,
      currentItem: navText ? parseInt(navText[1]) : 0,
      totalItems: navText ? parseInt(navText[2]) : 0,
      isApproved: isApproved,
      checkWork: checkWork,
      comboboxDebug: comboboxDebug,
      selectDebug: selectDebug,
      size: sizeValue,
    };
  });
}

// ============================================================
// SET CATEGORY
// ============================================================

async function setCategory(page, categoryName) {
  if (DRY_RUN) return;

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
    console.log('  >> Category dropdown not found');
    return;
  }

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

  const searchInput = await page.$('input[placeholder="Search..."]');
  if (searchInput) {
    await searchInput.type(categoryName.substring(0, 4), { delay: 50 });
    await delay(800);
  }

  const optionClicked = await page.evaluate((name) => {
    const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"]'));
    const match = options.find(o => o.textContent.trim().toLowerCase().includes(name.toLowerCase()));
    if (match) {
      match.click();
      return true;
    }
    return false;
  }, categoryName);

  if (optionClicked) {
    await delay(CONFIG.delayAfterAction);
  } else {
    await page.keyboard.press('Escape');
    await delay(300);
    console.log(`  >> Category option "${categoryName}" not found`);
  }
}

// ============================================================
// SET DROPDOWN (combobox type)
// ============================================================

async function setCombobox(page, ariaLabelMatch, value) {
  if (DRY_RUN) return true;

  const btnExists = await page.evaluate((label) => {
    const btn = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        return a === label.toLowerCase() || a.includes(label.toLowerCase());
      });
    return !!btn;
  }, ariaLabelMatch);

  if (!btnExists) {
    console.log(`  >> Combobox with aria-label "${ariaLabelMatch}" not found`);
    return false;
  }

  await page.evaluate((label) => {
    const btn = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        return a === label.toLowerCase() || a.includes(label.toLowerCase());
      });
    if (btn) btn.click();
  }, ariaLabelMatch);
  await delay(800);

  const optionResult = await page.evaluate((val) => {
    const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"]'));
    let match = options.find(o => o.textContent.trim().toLowerCase() === val.toLowerCase());
    if (!match) match = options.find(o => o.textContent.trim().toLowerCase().includes(val.toLowerCase()));
    if (match) {
      match.click();
      return { clicked: true };
    }
    const available = options.map(o => o.textContent.trim()).slice(0, 10).join(', ');
    return { clicked: false, available: available };
  }, value);

  if (optionResult.clicked) {
    await delay(CONFIG.delayAfterAction);
    return true;
  }

  console.log(`  >> Option "${value}" not found. Available: ${optionResult.available}`);
  await page.keyboard.press('Escape');
  await delay(300);
  return false;
}

// ============================================================
// SET NATIVE SELECT ELEMENT
// ============================================================

async function setNativeSelect(page, fieldName, value) {
  if (DRY_RUN) return true;

  const result = await page.evaluate((field, val) => {
    const allSelects = Array.from(document.querySelectorAll('select'));
    let targetSelect = null;

    for (const sel of allSelects) {
      const id = (sel.id || '').toLowerCase();
      const name = (sel.name || '').toLowerCase();
      if (field === 'unit' && id.includes('unit') && !id.includes('inventory') && !id.includes('inv')) {
        targetSelect = sel; break;
      }
      if (field === 'inventory' && (id.includes('inventory') || id.includes('inv_unit') || id.includes('invunit'))) {
        targetSelect = sel; break;
      }
      if (field === 'unit' && name.includes('unit') && !name.includes('inventory')) {
        targetSelect = sel; break;
      }
      if (field === 'inventory' && name.includes('inventory')) {
        targetSelect = sel; break;
      }
    }

    if (!targetSelect) {
      const labels = Array.from(document.querySelectorAll('label, span, div'));
      for (const label of labels) {
        const text = label.textContent.trim().toLowerCase();
        const isUnitLabel = (field === 'unit' && (text === 'unit*' || text === 'unit') && !text.includes('inventory'));
        const isInvLabel = (field === 'inventory' && text.includes('inventory unit'));
        if (isUnitLabel || isInvLabel) {
          const container = label.closest('div');
          if (container) {
            const sel = container.querySelector('select');
            if (sel) { targetSelect = sel; break; }
          }
        }
      }
    }

    if (!targetSelect) return { found: false };

    const options = Array.from(targetSelect.options);
    const match = options.find(o =>
      o.text.toLowerCase() === val.toLowerCase() ||
      o.value.toLowerCase() === val.toLowerCase()
    );

    if (match) {
      targetSelect.value = match.value;
      targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
      targetSelect.dispatchEvent(new Event('input', { bubbles: true }));
      return { found: true, set: true, value: match.text };
    }

    const available = options.map(o => o.text).filter(t => t).join(', ');
    return { found: true, set: false, available: available };
  }, fieldName, value);

  if (!result.found) {
    console.log(`  >> Native select for "${fieldName}" not found`);
    return false;
  }
  if (result.set) {
    await delay(500);
    return true;
  }
  console.log(`  >> Option "${value}" not in select. Available: ${result.available}`);
  return false;
}

// ============================================================
// SET UNIT (tries combobox first, then native select)
// ============================================================

async function setUnit(page, unitType, value) {
  if (DRY_RUN) return true;

  if (unitType === 'combobox') {
    return await setCombobox(page, 'Unit', value);
  } else if (unitType === 'select') {
    return await setNativeSelect(page, 'unit', value);
  }

  const comboResult = await setCombobox(page, 'Unit', value);
  if (comboResult) return true;
  return await setNativeSelect(page, 'unit', value);
}

async function setInventoryUnit(page, invUnitType, value) {
  if (DRY_RUN) return true;

  if (invUnitType === 'combobox') {
    return await setCombobox(page, 'Inventory unit', value);
  } else if (invUnitType === 'select') {
    return await setNativeSelect(page, 'inventory', value);
  }

  const comboResult = await setCombobox(page, 'Inventory unit', value);
  if (comboResult) return true;
  return await setNativeSelect(page, 'inventory', value);
}

// ============================================================
// CREATE PRODUCT
// ============================================================

async function createProduct(page, productName, itemDesc) {
  if (DRY_RUN) return true;

  const productInput = await page.$('input[placeholder="Start typing to select a product"]');
  if (!productInput) return false;

  await productInput.click({ clickCount: 3 });
  await productInput.type(productName, { delay: 50 });
  await delay(1500);

  const existingClicked = await page.evaluate(() => {
    const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"]'));
    if (options.length > 0) {
      options[0].click();
      return true;
    }
    return false;
  });

  if (existingClicked) {
    await delay(CONFIG.delayAfterAction);
    return true;
  }

  const addClicked = await page.evaluate((name) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => b.textContent.toLowerCase().includes(`add "${name}"`))
      || buttons.find(b => b.textContent.toLowerCase().includes('add "'));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }, productName);

  if (addClicked) {
    await delay(1500);

    const familyUnit = determineFamilyUnit(itemDesc);
    const familyInput = await page.$('input[placeholder="Select product unit"]');
    if (familyInput) {
      const currentUnit = await page.evaluate(el => el.value, familyInput);
      if (currentUnit.toLowerCase() !== familyUnit.toLowerCase()) {
        await familyInput.click({ clickCount: 3 });
        await familyInput.type(familyUnit, { delay: 50 });
        await delay(500);
        const unitClicked = await page.evaluate((unit) => {
          const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"]'));
          const match = options.find(o => o.textContent.trim().toLowerCase() === unit.toLowerCase());
          if (match) {
            match.click();
            return true;
          }
          return false;
        }, familyUnit);
        if (unitClicked) {
          await delay(500);
        }
      }
    }

    const addProductClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find(b => b.textContent.trim() === 'Add Product');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (addProductClicked) {
      await delay(CONFIG.delayAfterAction);
      return true;
    }
  }

  return false;
}

// ============================================================
// CLICK APPROVE (with navigation wait)
// ============================================================

async function clickApprove(page, previousDescription, previousItemNumber) {
  if (DRY_RUN) return true;

  const approved = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => b.textContent.trim() === 'Approve');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (!approved) {
    console.log('  >> Approve button not found');
    return false;
  }

  // Wait 2 seconds for any dialog or validation error to appear
  await delay(2000);

  // CHECK FOR VALIDATION ERRORS — but only if we're still on the SAME item
  // If the page already advanced to a different item, the approve succeeded
  try {
    const pageState = await page.evaluate((prevDesc) => {
      const descEl = document.getElementById('item_description');
      const currentDesc = descEl ? descEl.value : '';
      const pageText = document.body.innerText;
      const hasValidationMsg = pageText.includes('fields must be added prior') ||
          pageText.includes('required fields') ||
          pageText.includes('(*) fields must') ||
          pageText.includes('must be added prior to approving');
      const stillToReview = !!Array.from(document.querySelectorAll('span'))
        .find(s => s.textContent.trim() === 'TO REVIEW');
      return {
        currentDesc,
        descriptionChanged: currentDesc !== prevDesc,
        hasValidationMsg,
        stillToReview,
      };
    }, previousDescription);

    // If description changed, the page advanced = approve succeeded
    // The validation message belongs to the NEXT item, not the current one
    if (pageState.descriptionChanged) {
      console.log(`  >> Page already advanced to new item ("${pageState.currentDesc.substring(0, 40)}...")`);
      console.log('  >> Approve succeeded (validation message is from next item)');
      // Wait for page to stabilize before returning
      await delay(1500);
      return true;
    }

    // Same item still showing + validation error = approve actually failed
    if (pageState.hasValidationMsg && !pageState.descriptionChanged) {
      console.log('  >> VALIDATION ERROR on current item (description unchanged)');
      console.log('  >> Approve blocked by required fields. Flagging and skipping...');
      return false;
    }
  } catch (e) {
    if (e.message.includes('detached') || e.message.includes('Detached') || e.message.includes('destroyed')) {
      console.log('  >> Page reloaded after approve (frame detached). Waiting for new page...');
      await delay(5000);
      return true;
    }
  }

  // Handle "Assign products?" dialog (wrapped in try-catch for detached frame)
  try {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const yesBtn = buttons.find(b => b.textContent.trim() === 'Yes');
      const noBtn = buttons.find(b => b.textContent.trim() === 'No');
      const btn = yesBtn || noBtn;
      if (btn) btn.click();
    });
    await delay(1000);
  } catch (e) {
    if (e.message.includes('detached') || e.message.includes('Detached') || e.message.includes('destroyed')) {
      console.log('  >> Page reloaded after approve (frame detached). Waiting for new page...');
      await delay(5000);
      return true;
    }
    throw e;
  }

  // NOW WAIT for the page to actually advance to a new item
  const advanced = await waitForItemChange(
    page,
    previousDescription,
    previousItemNumber,
    CONFIG.maxWaitForNavigation
  );

  if (!advanced) {
    // Double-check: is the item still TO REVIEW? If so, approve failed
    try {
      const stillBlocked = await page.evaluate((prevDesc) => {
        const descEl = document.getElementById('item_description');
        const currentDesc = descEl ? descEl.value : '';
        const stillToReview = !!Array.from(document.querySelectorAll('span'))
          .find(s => s.textContent.trim() === 'TO REVIEW');
        return stillToReview && currentDesc === prevDesc;
      }, previousDescription);

      if (stillBlocked) {
        console.log('  >> Approve did NOT succeed (item still TO REVIEW). Flagging...');
        return false;
      }
    } catch (e) {
      if (e.message.includes('detached') || e.message.includes('Detached')) {
        console.log('  >> Frame detached. Approve likely succeeded.');
        await delay(5000);
        return true;
      }
    }

    console.log('  >> WARNING: Page did not advance after approve. Attempting manual navigation...');
    try {
      await forceNavigateNext(page);
    } catch (e) {
      if (e.message.includes('detached') || e.message.includes('Detached')) {
        console.log('  >> Frame detached during navigation. Waiting...');
        await delay(5000);
        return true;
      }
      throw e;
    }
    await delay(2000);
  }

  return true;
}

// ============================================================
// FORCE NAVIGATE TO NEXT ITEM
// ============================================================

async function forceNavigateNext(page) {
  // Try clicking the forward arrow
  const nextClicked = await page.evaluate(() => {
    const arrows = Array.from(document.querySelectorAll('button, a, span'));
    // Try aria-label first
    let next = arrows.find(a => {
      const label = (a.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('next') || label.includes('forward');
    });
    // Try common next arrow characters
    if (!next) {
      next = arrows.find(a => {
        const text = a.textContent.trim();
        return text === '›' || text === '→' || text === '>' || text === 'chevron_right' ||
               text === 'navigate_next' || text === 'arrow_forward';
      });
    }
    // Try SVG arrow buttons
    if (!next) {
      const svgBtns = Array.from(document.querySelectorAll('button'));
      const navBtns = svgBtns.filter(b => {
        const svg = b.querySelector('svg');
        return svg && b.closest('[class*="nav"], [class*="arrow"], [class*="pagination"]');
      });
      if (navBtns.length >= 2) next = navBtns[1];
    }
    if (next) {
      next.click();
      return true;
    }
    return false;
  });

  if (nextClicked) {
    console.log('  >> Clicked Next arrow');
    await delay(2000);
    return true;
  }

  // Try keyboard
  console.log('  >> Trying keyboard navigation...');
  await page.keyboard.press('ArrowRight');
  await delay(1000);
  return false;
}

// ============================================================
// CLICK SAVE AND NEXT (for flagged/skipped items)
// ============================================================

async function clickSaveAndNext(page) {
  const saved = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => {
      const text = b.textContent.trim();
      return text === 'Save Changes' || text === 'Save';
    });
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (saved) {
    console.log('  >> Clicked Save');
    await delay(2000);
  }

  await forceNavigateNext(page);
}

// ============================================================
// PROCESS A SINGLE ITEM
// Returns: { result: string, description: string, itemNumber: number }
// ============================================================

async function processItem(page, lastDescription, lastItemNumber) {
  const item = await readCurrentItem(page);

  // DUPLICATE DETECTION: If we see the exact same item as last time, the page didn't advance
  if (item.description && item.description === lastDescription && item.currentItem === lastItemNumber) {
    console.log(`\n  >> DUPLICATE DETECTED: "${item.description}" (item ${item.currentItem})`);
    console.log('  >> Page did not advance. Forcing navigation...');
    await forceNavigateNext(page);
    await delay(2000);

    // Re-read after navigation
    const newItem = await readCurrentItem(page);
    if (newItem.description === lastDescription && newItem.currentItem === lastItemNumber) {
      console.log('  >> Still stuck on same item after force navigation.');
      console.log('  >> This item may be the last in the batch. Checking for batch complete...');

      const reviewComplete = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const viewLibBtn = btns.find(b => b.textContent.includes('View item library'));
        return !!viewLibBtn && document.body.innerText.includes('Review complete');
      });

      if (reviewComplete) {
        return { result: 'batch_complete', description: item.description, itemNumber: item.currentItem, totalItems: item.totalItems };
      }

      // Flag and skip
      logItem(CONFIG.flaggedLogFile, {
        item: item.description,
        vendor: item.vendor,
        product: '',
        category: '',
        glCode: '',
        familyUnit: '',
        status: 'STUCK',
        notes: 'Page did not advance after approve and force navigation',
      });
      return { result: 'stuck', description: item.description, itemNumber: item.currentItem, totalItems: item.totalItems };
    }

    // Successfully navigated to a new item, use the new data
    Object.assign(item, newItem);
  }

  const japaneseFlag = isJapaneseFish(item.vendor, item.description);
  const nonFoodFlag = isNonFood(item.description);
  const targetGLCode = japaneseFlag ? CONFIG.ishinGLCode : CONFIG.defaultGLCode;
  const targetCategory = nonFoodFlag ? CONFIG.nonFoodCategory : CONFIG.defaultCategory;
  const productName = cleanProductName(item.description);
  const familyUnit = determineFamilyUnit(item.description);

  console.log(`\n--- Item ${item.currentItem} of ${item.totalItems} ---`);
  console.log(`  Description: ${item.description}`);
  console.log(`  Vendor:      ${item.vendor}`);
  console.log(`  Current Cat: ${item.category}`);
  console.log(`  Current GL:  ${item.glCode}`);
  console.log(`  Has Product: ${item.hasProduct}`);
  console.log(`  Size:        ${item.size || '(empty)'}`);
  console.log(`  Unit:        ${item.unit} (${item.unitType})`);
  console.log(`  Inv Unit:    ${item.inventoryUnit} (${item.invUnitType})`);
  if (item.checkWork) console.log(`  Check Work:  ${item.checkWork.substring(0, 100)}`);
  console.log('  ---');
  console.log(`  Japanese:    ${japaneseFlag}`);
  console.log(`  Non-food:    ${nonFoodFlag}`);
  console.log(`  >> GL Code:  ${targetGLCode}`);
  console.log(`  >> Category: ${targetCategory}`);
  console.log(`  >> Product:  ${productName}`);
  console.log(`  >> Family:   ${familyUnit}`);

  if (DRY_RUN) {
    console.log('  >> [DRY RUN] Would process this item with above settings');
    logItem(CONFIG.auditLogFile, {
      item: item.description,
      vendor: item.vendor,
      product: productName,
      category: targetCategory,
      glCode: targetGLCode,
      familyUnit: familyUnit,
      status: 'DRY_RUN',
      notes: japaneseFlag ? 'Japanese fish (Ishin GL)' : (nonFoodFlag ? 'Non-food item' : ''),
    });
    await clickSaveAndNext(page);
    return { result: 'dry_run', description: item.description, itemNumber: item.currentItem, totalItems: item.totalItems };
  }

  // Skip if already approved
  if (item.isApproved) {
    console.log('  >> Already APPROVED, skipping...');
    logItem(CONFIG.auditLogFile, {
      item: item.description,
      vendor: item.vendor,
      product: '',
      category: item.category,
      glCode: item.glCode,
      familyUnit: '',
      status: 'SKIPPED',
      notes: 'Already approved',
    });
    await forceNavigateNext(page);
    return { result: 'skipped', description: item.description, itemNumber: item.currentItem, totalItems: item.totalItems };
  }

  // Step 0: Fill Size field if empty (REQUIRED for approval)
  const sizeMissing = !item.size || item.size.trim() === '';
  if (sizeMissing) {
    console.log('  >> Size is empty (required). Setting to 1...');
    await setSizeField(page, '1');
  } else {
    console.log(`  >> Size already set: ${item.size}`);
  }

  // Check if Unit is truly missing vs already set
  const unitMissing = !item.unit || item.unit.toLowerCase().includes('select') || item.unit.trim() === '';
  const invUnitMissing = !item.inventoryUnit || item.inventoryUnit.toLowerCase().includes('select') || item.inventoryUnit.trim() === '';

  if (unitMissing) {
    console.log('  >> Unit is missing. Attempting to set to lb...');
    const unitSet = await setUnit(page, item.unitType, 'lb');
    if (!unitSet) {
      console.log('  >> Could not set Unit, will try to proceed anyway');
    }
  } else {
    console.log(`  >> Unit already set: ${item.unit}`);
  }

  // Step 1: Set category
  if (item.category.toLowerCase() !== targetCategory.toLowerCase()) {
    console.log(`  >> Setting category to: ${targetCategory}`);
    await setCategory(page, targetCategory);
  }

  // Step 2: Set GL code
  console.log(`  >> Setting GL code to: ${targetGLCode}`);
  await setGLCode(page, targetGLCode);

  // Step 3: Create/assign product
  if (!item.hasProduct) {
    console.log(`  >> Creating product: ${productName}`);
    const productCreated = await createProduct(page, productName, item.description);
    if (!productCreated) {
      console.log('  >> Warning: Could not create product, proceeding anyway');
      logItem(CONFIG.flaggedLogFile, {
        item: item.description,
        vendor: item.vendor,
        product: productName,
        category: targetCategory,
        glCode: targetGLCode,
        familyUnit: familyUnit,
        status: 'FLAGGED',
        notes: 'Could not create or assign product',
      });
    }
  }

  // Step 4: Handle inventory unit if missing
  if (invUnitMissing) {
    console.log('  >> Inventory unit missing. Attempting to set...');
    const invSet = await setInventoryUnit(page, item.invUnitType, 'lb');
    if (!invSet) {
      console.log('  >> Warning: Could not set inventory unit, proceeding anyway');
    }
  }

  // Step 5: Approve (with navigation wait)
  console.log('  >> Clicking Approve...');
  const approved = await clickApprove(page, item.description, item.currentItem);

  if (approved) {
    console.log('  >> APPROVED');
    logItem(CONFIG.auditLogFile, {
      item: item.description,
      vendor: item.vendor,
      product: productName,
      category: targetCategory,
      glCode: targetGLCode,
      familyUnit: familyUnit,
      status: 'APPROVED',
      notes: japaneseFlag ? 'Japanese fish (Ishin GL)' : (nonFoodFlag ? 'Non-food item' : ''),
    });
    return { result: 'approved', description: item.description, itemNumber: item.currentItem, totalItems: item.totalItems };
  } else {
    console.log('  >> Could not approve (validation error or missing required fields).');
    console.log('  >> Saving current state and moving to next item...');
    
    // Dismiss any error dialogs first
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const dismissBtn = buttons.find(b => {
          const text = b.textContent.trim().toLowerCase();
          return text === 'ok' || text === 'close' || text === 'dismiss' || text === 'got it';
        });
        if (dismissBtn) dismissBtn.click();
      });
      await delay(500);
    } catch (e) {}

    // Click Save to preserve what we've set so far
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const btn = buttons.find(b => {
          const text = b.textContent.trim();
          return text === 'Save' || text === 'Save Changes';
        });
        if (btn) btn.click();
      });
      await delay(2000);
    } catch (e) {}

    // Force navigate to next item
    try {
      await forceNavigateNext(page);
      await delay(2000);
    } catch (e) {
      if (e.message.includes('detached') || e.message.includes('Detached')) {
        await delay(5000);
      }
    }

    logItem(CONFIG.flaggedLogFile, {
      item: item.description,
      vendor: item.vendor,
      product: productName,
      category: targetCategory,
      glCode: targetGLCode,
      familyUnit: familyUnit,
      status: 'FLAGGED',
      notes: 'Approve blocked by validation error (missing required fields). Saved and skipped.',
    });
    return { result: 'flagged', description: item.description, itemNumber: item.currentItem, totalItems: item.totalItems };
  }
}

// ============================================================
// NAVIGATE TO ITEM LIBRARY AND APPLY FILTER
// ============================================================

async function navigateAndFilter(page) {
  await page.goto(CONFIG.itemLibraryUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  const filterClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => b.textContent.includes('More Filters') || b.textContent.includes('more_filters'));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (filterClicked) {
    await delay(1000);

    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label, span'));
      const label = labels.find(l => l.textContent.trim() === 'To Review');
      if (label) {
        const checkbox = label.closest('label')?.querySelector('input[type="checkbox"]')
          || label.previousElementSibling;
        const target = checkbox || label;
        if (target) target.click();
      }
    });
    await delay(500);

    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find(b => b.textContent.includes('Apply'));
      if (btn) btn.click();
    });
    await delay(2000);
  }
}

async function clickFirstToReviewItem(page) {
  const clicked = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const row = rows.find(r => r.textContent.includes('TO REVIEW'));
    if (row) {
      row.click();
      return true;
    }
    return false;
  });

  if (clicked) {
    await delay(3000);
    return true;
  }
  return false;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('==============================================');
  console.log('  xtraCHEF Inventory Processor v3.6');
  console.log('  Celestia + Ishin');
  console.log('==============================================');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (read only)' : 'LIVE (will make changes)'}`);
  console.log(`  Limit: ${LIMIT} items`);
  console.log(`  Pause: ${PAUSE_EACH ? 'Yes (after each item)' : 'No'}`);
  console.log('==============================================\n');

  initAuditLog();

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
  await navigateAndFilter(page);

  console.log('Clicking into first TO REVIEW item...');
  const found = await clickFirstToReviewItem(page);
  if (!found) {
    console.log('No TO REVIEW items found. Exiting.');
    await browser.close();
    return;
  }

  if (!DRY_RUN) {
    console.log('\n========================================');
    console.log('  READY TO START LIVE PROCESSING');
    console.log('  This will modify items in xtraCHEF.');
    console.log('  Press ENTER to start, or Ctrl+C to abort.');
    console.log('========================================\n');
    await waitForEnter('Press ENTER to begin processing... ');
  }

  let totalProcessed = 0;
  let totalApproved = 0;
  let totalFlagged = 0;
  let totalSkipped = 0;
  let totalDryRun = 0;
  let totalStuck = 0;
  let consecutiveErrors = 0;
  let consecutiveStuck = 0;
  let lastDescription = '';
  let lastItemNumber = 0;

  while (consecutiveErrors < CONFIG.maxRetries && consecutiveStuck < 3 && totalProcessed < LIMIT) {
    try {
      const outcome = await processItem(page, lastDescription, lastItemNumber);

      // Handle batch complete
      if (outcome.result === 'batch_complete') {
        console.log('\n>> Batch complete! Loading next batch...');

        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const btn = buttons.find(b => b.textContent.includes('View item library'));
          if (btn) btn.click();
        });
        await delay(3000);

        await navigateAndFilter(page);

        const nextFound = await clickFirstToReviewItem(page);
        if (!nextFound) {
          console.log('\n>> No more TO REVIEW items! All done!');
          break;
        }

        lastDescription = '';
        lastItemNumber = 0;
        consecutiveStuck = 0;
        continue;
      }

      // Handle stuck
      if (outcome.result === 'stuck') {
        totalStuck++;
        consecutiveStuck++;
        console.log(`  >> Stuck count: ${consecutiveStuck}/3`);
        if (consecutiveStuck >= 3) {
          console.log('\n>> Stuck 3 times in a row. Going back to item library...');
          await navigateAndFilter(page);
          const nextFound = await clickFirstToReviewItem(page);
          if (!nextFound) {
            console.log('\n>> No more TO REVIEW items! All done!');
            break;
          }
          consecutiveStuck = 0;
          lastDescription = '';
          lastItemNumber = 0;
        }
        continue;
      }

      // Normal processing
      totalProcessed++;
      consecutiveStuck = 0;
      if (outcome.result === 'approved') totalApproved++;
      else if (outcome.result === 'flagged') totalFlagged++;
      else if (outcome.result === 'skipped') totalSkipped++;
      else if (outcome.result === 'dry_run') totalDryRun++;

      // If this was the last item in the batch (skipped or flagged), go to library for next batch
      if ((outcome.result === 'skipped' || outcome.result === 'flagged') && outcome.itemNumber > 0 && outcome.totalItems > 0 && outcome.itemNumber >= outcome.totalItems) {
        console.log(`  >> Last item in batch (${outcome.itemNumber}/${outcome.totalItems}). Checking for next batch...`);
        await navigateAndFilter(page);
        const nextFound = await clickFirstToReviewItem(page);
        if (!nextFound) {
          console.log('\n>> No more TO REVIEW items! All done!');
          break;
        }
        lastDescription = '';
        lastItemNumber = 0;
        continue;
      }

      // Track last item for duplicate detection
      lastDescription = outcome.description;
      lastItemNumber = outcome.itemNumber;

      consecutiveErrors = 0;

      console.log(`\n  TOTALS: ${totalApproved} approved | ${totalFlagged} flagged | ${totalSkipped} skipped | ${totalStuck} stuck | ${totalProcessed}/${LIMIT} total`);

      if (PAUSE_EACH) {
        await waitForEnter('  Press ENTER for next item (Ctrl+C to stop)... ');
      }

      // Check for "Review complete" dialog (end of batch)
      const reviewComplete = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const viewLibBtn = btns.find(b => b.textContent.includes('View item library'));
        return !!viewLibBtn && document.body.innerText.includes('Review complete');
      });

      if (reviewComplete) {
        console.log('\n>> Batch complete! Loading next batch...');

        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const btn = buttons.find(b => b.textContent.includes('View item library'));
          if (btn) btn.click();
        });
        await delay(3000);

        await navigateAndFilter(page);

        const nextFound = await clickFirstToReviewItem(page);
        if (!nextFound) {
          console.log('\n>> No more TO REVIEW items! All done!');
          break;
        }

        lastDescription = '';
        lastItemNumber = 0;
      }

      await delay(CONFIG.delayBetweenItems);

    } catch (error) {
      // Handle detached frame errors by recovering the page
      if (error.message.includes('detached') || error.message.includes('Detached') || error.message.includes('destroyed')) {
        console.log('\n  >> Frame detached (page reloaded). Recovering...');
        await delay(5000);

        // Try to get the active page from the browser
        try {
          const pages = await browser.pages();
          const activePage = pages.find(p => p.url().includes('toasttab.com')) || pages[pages.length - 1];
          if (activePage && activePage !== page) {
            page = activePage;
            console.log('  >> Switched to active page: ' + page.url().substring(0, 60));
          }
          // Wait for the page to stabilize
          await delay(3000);

          // Check if we're on the item DETAIL view or the item LIBRARY list
          // The detail view has an item_description input; the list view has a table with TO REVIEW rows
          const pageContext = await page.evaluate(() => {
            const descEl = document.getElementById('item_description');
            const hasItemDetail = !!descEl;
            const hasTableRows = document.querySelectorAll('tr').length > 3;
            const hasInvoiceNav = document.body.innerText.includes('Invoice item');
            return { hasItemDetail, hasTableRows, hasInvoiceNav };
          });

          if (pageContext.hasItemDetail || pageContext.hasInvoiceNav) {
            // We're still in the item detail view, just continue processing
            console.log('  >> Still in item detail view. Continuing...');
          } else if (pageContext.hasTableRows) {
            // We're at the item library list, need to click into a TO REVIEW item
            console.log('  >> At item library list. Clicking into first TO REVIEW item...');
            const found = await clickFirstToReviewItem(page);
            if (!found) {
              console.log('\n>> No more TO REVIEW items! All done!');
              break;
            }
          } else {
            // Unknown state, try navigating to item library
            console.log('  >> Unknown page state. Navigating to item library...');
            await navigateAndFilter(page);
            const found = await clickFirstToReviewItem(page);
            if (!found) {
              console.log('\n>> No more TO REVIEW items! All done!');
              break;
            }
          }

          lastDescription = '';
          lastItemNumber = 0;
          consecutiveErrors = 0;
          consecutiveStuck = 0;
          continue;
        } catch (recoveryError) {
          console.log(`  >> Recovery failed: ${recoveryError.message}`);
        }
      }

      consecutiveErrors++;
      console.log(`\n  ERROR (${consecutiveErrors}/${CONFIG.maxRetries}): ${error.message}`);

      if (consecutiveErrors >= CONFIG.maxRetries) {
        console.log('\n>> Too many consecutive errors. Stopping.');
        break;
      }

      try {
        const screenshotPath = `error-screenshot-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath });
        console.log(`  Screenshot saved: ${screenshotPath}`);
      } catch (e) {}

      await delay(3000);
    }
  }

  console.log('\n==============================================');
  console.log('  PROCESSING COMPLETE');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  Total processed: ${totalProcessed}`);
  console.log(`  Approved (auto): ${totalApproved}`);
  console.log(`  Flagged (manual): ${totalFlagged}`);
  console.log(`  Skipped (already done): ${totalSkipped}`);
  console.log(`  Stuck (navigation failed): ${totalStuck}`);
  if (DRY_RUN) console.log(`  Dry run previewed: ${totalDryRun}`);
  console.log(`  Audit log: ${CONFIG.auditLogFile}`);
  console.log(`  Flagged items: ${CONFIG.flaggedLogFile}`);
  console.log('==============================================\n');

  await waitForEnter('Press ENTER to close the browser... ');
  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
