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
const USE_EXPORT = process.argv.includes('--export');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1]);
  return 9999;
})();
const EXPORT_FILE = (() => {
  const idx = process.argv.indexOf('--export');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
})();

// ============================================================
// CATEGORY + GL MAPPING RULES
// ============================================================
//
// Two types of rules:
//   1. VENDOR rules: match by vendor name (highest priority)
//   2. KEYWORD rules: match by item description
//
// Each rule specifies:
//   - category: target category name in xtraCHEF
//   - glCode: target GL code (null = don't change GL)
//   - keywords OR vendors: match criteria
//
// First match wins. Order matters.
// ============================================================

const VENDOR_RULES = [
  {
    category: 'Liquor',
    glCode: 'Event materials',
    vendors: ['Empire Distributors'],
    // Exception: some Empire items are NA Beverages, not liquor
    // Those should already have the correct category, so we only
    // recategorize items currently in "Food Purchases"
  },
  {
    category: 'Liquor',
    glCode: 'Event materials',
    vendors: ['SAVANNAH DISTRIBUTING CO INC'],
  },
  {
    category: 'Liquor',
    glCode: 'Event materials',
    vendors: ['General Wholesale Company'],
  },
  // Japanese seafood suppliers
  {
    category: 'Seafood',
    glCode: null,
    vendors: ['One Ocean'],
  },
  {
    category: 'Seafood',
    glCode: null,
    vendors: ['East Sea Trading'],
  },
  {
    category: 'Seafood',
    glCode: null,
    vendors: ['OHTA FOODS MARKET CO, Ltd.'],
  },
  {
    category: 'Seafood',
    glCode: null,
    vendors: ['True World Foods Atlanta'],
  },
  {
    category: 'Seafood',
    glCode: null,
    vendors: ['Arrivato Imports LLC'],
  },
  {
    category: 'Seafood',
    glCode: null,
    vendors: ['Pure Chilean, LLC'],
  },
  {
    category: 'Seafood',
    glCode: null,
    vendors: ['Farmers & Fishermen Purveyors'],
  },
  // Japanese dry goods / pantry suppliers
  {
    category: 'Dry Goods',
    glCode: null,
    vendors: ['ATLANTA MUTUAL TRADING'],
  },
  {
    category: 'Dry Goods',
    glCode: null,
    vendors: ['JFC'],
  },
  {
    category: 'Dry Goods',
    glCode: null,
    vendors: ['JFC - 50'],
  },
  {
    category: 'Dry Goods',
    glCode: null,
    vendors: ['YAMASHO Atlanta Inc'],
  },
  {
    category: 'Dry Goods',
    glCode: null,
    vendors: ['Larder Foods'],
  },
  // Specialty produce / mixed vendors (keyword rules handle specifics)
  // Note: Athena Farms, Sysco, Al Madina, International Gourmet are mixed
  // vendors. They stay keyword-matched, not vendor-matched.
  //
  // Non-food vendors
  {
    category: 'Non-Food Items',
    glCode: 'Supplies',
    vendors: ['OFFICE DEPOT OFFICEMAX'],
  },
  {
    category: 'Non-Food Items',
    glCode: 'Supplies',
    vendors: ['Edward Don'],
  },
  // Note: RNDC, Prime Wine & Spirits, Winebow already have correct categories
  // Only add them here if items from these vendors are in Food Purchases
];

const KEYWORD_RULES = [
  // Liquor/alcohol from non-liquor vendors (e.g., grocery stores)
  {
    category: 'Liquor',
    glCode: 'Event materials',
    keywords: [
      'sake 1.5', 'sake 720', 'sake 300', 'sake bottle',
      'junmai daiginjo', 'junmai ginjo', 'daiginjo', 'nigori sake',
      'shochu', 'soju', 'umeshu',
    ],
  },
  // Cleaning
  {
    category: 'Cleaning Supplies',
    glCode: 'Supplies',
    keywords: [
      'bleach', 'sanitizer', 'sanitize', 'disinfect', 'detergent',
      'soap', 'degreaser', 'cleaner', 'cleaning', 'rinse aid',
      'sponge', 'scrub pad', 'mop', 'broom',
    ],
  },
  // Bar Supplies
  {
    category: 'Bar Supplies',
    glCode: 'Supplies',
    keywords: [
      'cocktail napkin', 'bar napkin', 'stir stick', 'swizzle',
      'cocktail straw', 'bar towel', 'jigger', 'shaker',
      'coaster', 'toothpick', 'cocktail pick', 'bar pick',
      'bar mat', 'pour spout', 'speed pour',
    ],
  },
  // Kitchen Supplies
  {
    category: 'Kitchen Supplies',
    glCode: 'Supplies',
    keywords: [
      'pastry bag', 'piping bag', 'disposable bag',
      'parchment paper', 'wax paper', 'cheesecloth',
    ],
  },
  // Non-Food Items
  {
    category: 'Non-Food Items',
    glCode: 'Cost of goods sold',
    keywords: [
      'toilet paper', 'paper towel', 'napkin', 'glove', 'nitrile',
      'trash bag', 'garbage bag', 'aluminum foil', 'foil wrap',
      'plastic wrap', 'cling film', 'cling wrap', 'saran',
      'apron', 'wiper towel',
      'purchase summary', 'delivery fee', 'fuel surcharge',
    ],
  },
  // ============================================================
  // FOOD SUBCATEGORY RULES (for items in "Food Purchases")
  // These move items from generic "Food Purchases" to specific
  // food subcategories. GL code stays the same (null = no change).
  // ============================================================
  // Seafood
  {
    category: 'Seafood',
    glCode: null,
    keywords: [
      'salmon', 'tuna', 'shrimp', 'prawn', 'crab', 'lobster',
      'scallop', 'mussel', 'mussels', 'clam', 'oyster', 'squid', 'calamari',
      'octopus', 'tako', 'uni ', 'ikura', 'tobiko', 'masago',
      'hamachi', 'yellowtail', 'snapper', 'sea bass', 'branzino',
      'halibut', 'cod ', 'swordfish', 'mahi', 'grouper',
      'tilapia', 'catfish', 'trout', 'mackerel', 'saba ',
      'eel ', 'unagi', 'anago', 'ika ', 'ebi ', 'hotate',
      'fish', 'seafood', 'sashimi',
      'crabmeat', 'crab meat', 'surimi', 'kani ',
      'anchovy', 'anchovies', 'sardine',
      'crawfish', 'langoustine',
      'lump crab', 'snow crab', 'king crab',
      'amaebi', 'hirame', 'madai', 'kanpachi',
      'suzuki', 'tai ', 'maguro', 'engawa',
      'yagara', 'cornet fish',
      'one ocean',  // vendor-in-keyword fallback
    ],
  },
  // Meat / Protein
  {
    category: 'Meat/ Protein',
    glCode: null,
    keywords: [
      'chicken', 'beef', 'pork', 'lamb', 'duck', 'quail', 'turkey',
      'wagyu', 'ribeye', 'strip steak', 'tenderloin', 'filet', 'fillet',
      'ground meat', 'ground beef', 'ground pork', 'ground lamb',
      'bacon', 'sausage', 'chorizo', 'prosciutto', 'salami',
      'thigh', 'breast', 'wing', 'drumstick', 'leg quarter',
      'bnls', 'boneless', 'bone-in', 'bone in',
      'oxtail', 'short rib', 'brisket', 'chuck', 'flank',
      'pork belly', 'pork loin', 'pork chop', 'pork shoulder',
      'ham ', 'pepperoni', 'mortadella', 'bresaola',
      'liver', 'gizzard', 'heart',
      'veal', 'venison', 'rabbit', 'goat',
      'rack ', 'french rack', 'lamb rack',
      'halal', 'blsl',
    ],
  },
  // Produce
  {
    category: 'Produce',
    glCode: null,
    keywords: [
      'lettuce', 'spinach', 'kale', 'arugula', 'cabbage',
      'tomato', 'onion', 'garlic',
      'jalapeno', 'habanero', 'serrano',
      'carrot', 'celery', 'cucumber', 'zucchini',
      'broccoli', 'cauliflower', 'asparagus', 'artichoke',
      'mushroom', 'shiitake', 'enoki', 'maitake', 'oyster mushroom',
      'potato', 'sweet potato', 'yam ',
      'avocado', 'lime ', 'lemon', 'orange ',
      'apple', 'banana', 'mango', 'papaya', 'pineapple',
      'strawberry', 'blueberry', 'raspberry', 'blackberry',
      'watermelon', 'melon', 'cantaloupe', 'honeydew',
      'peach', 'pear ', 'plum', 'cherry', 'grape',
      'basil', 'cilantro', 'parsley', 'mint ', 'thyme', 'rosemary',
      'dill ', 'chive', 'scallion', 'green onion', 'shallot',
      'ginger', 'galangal', 'lemongrass', 'turmeric',
      'bean sprout', 'sprouts', 'edamame',
      'corn ', 'peas', 'green bean', 'snap pea', 'snow pea',
      'eggplant', 'squash', 'pumpkin', 'butternut',
      'radish', 'daikon', 'turnip', 'beet',
      'fennel', 'bok choy', 'napa cabbage',
      'watercress', 'endive', 'radicchio',
      'lychee', 'dragon fruit', 'passion fruit', 'coconut',
      'fig ', 'date ', 'pomegranate', 'persimmon', 'yuzu',
      'microgreen', 'mixed greens', 'mesclun',
      'herb', 'romaine', 'iceberg',
      'brussel', 'brussels',
      'fonion', 'f onion',
    ],
  },
  // Dairy
  {
    category: 'Dairy',
    glCode: null,
    keywords: [
      'milk', 'cream', 'butter', 'cheese', 'yogurt', 'yoghurt',
      'mozzarella', 'parmesan', 'cheddar', 'gouda', 'brie',
      'cream cheese', 'ricotta', 'mascarpone', 'burrata',
      'sour cream', 'creme fraiche', 'half and half', 'half & half',
      'heavy cream', 'whipping cream', 'whole milk', 'skim milk',
      'buttermilk', 'condensed milk', 'evaporated milk',
      'egg ', 'eggs',
      'manchego', 'gruyere', 'pecorino', 'feta', 'goat cheese',
      'blue cheese', 'gorgonzola', 'stilton',
      'queso', 'cotija', 'oaxaca cheese',
      'plugra', 'asher blue',
    ],
  },
  // Dry Goods / Pantry
  {
    category: 'Dry Goods',
    glCode: null,
    keywords: [
      'rice ', 'flour', 'sugar', 'salt ',
      'pasta', 'noodle', 'spaghetti', 'penne', 'linguine',
      'soy sauce', 'shoyu', 'tamari', 'fish sauce',
      'vinegar', 'mirin', 'cooking sake', 'cooking wine',
      'sesame oil', 'olive oil', 'canola oil', 'vegetable oil',
      'panko', 'breadcrumb', 'tempura',
      'miso', 'dashi', 'bonito', 'kombu', 'nori', 'seaweed',
      'wasabi', 'sriracha', 'hot sauce', 'chili sauce',
      'ketchup', 'mustard', 'mayonnaise', 'mayo',
      'soybean', 'tofu', 'bean curd',
      'dried', 'dehydrated',
      'seasoning', 'cumin', 'paprika', 'oregano',
      'cinnamon', 'nutmeg', 'clove', 'allspice',
      'cayenne', 'black pepper', 'white pepper',
      'cornstarch', 'corn starch', 'potato starch', 'tapioca',
      'baking soda', 'baking powder', 'yeast',
      'honey', 'maple syrup', 'molasses', 'agave',
      'chocolate', 'cocoa', 'vanilla extract', 'vanilla bean',
      'almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'peanut',
      'coconut milk', 'coconut cream',
      'tomato paste', 'tomato sauce', 'san marzano',
      'lentil', 'chickpea',
      'jam ', 'jelly', 'preserve',
      'pickle', 'pickled', 'kimchi',
      'spring roll', 'wonton', 'dumpling', 'gyoza',
      'tortilla', 'wrap ',
      'hondashi', 'ajinomoto',
      'truffle ', 'truffle oil', 'truffle salt',
      'puree', 'coulis',
    ],
  },
  // Baked Goods
  {
    category: 'Baked Goods',
    glCode: null,
    keywords: [
      'bread', 'baguette', 'croissant', 'brioche', 'ciabatta',
      'roll ', 'rolls ', 'bun ', 'pita', 'naan', 'flatbread',
      'cake ', 'pastry', 'pie ',
      'cookie', 'brownie', 'muffin', 'scone',
      'donut', 'doughnut',
    ],
  },
  // Beverages (non-alcohol)
  {
    category: 'Beverages',
    glCode: null,
    keywords: [
      'soda ', 'cola ', 'sprite', 'ginger ale',
      'coffee', 'espresso',
      'tonic', 'club soda',
      'lemonade', 'iced tea',
      'energy drink', 'red bull',
      'kombucha',
      'coke soda', 'diet coke', 'fanta',
    ],
  },
];

// Only recategorize items currently in these categories
const SOURCE_CATEGORIES = ['Food Purchases', 'Food Purchases '];

// ============================================================
// GL CODE FIXES (independent of category changes)
// Fix items that have wrong GL codes regardless of category
// ============================================================

const GL_FIXES = [
  {
    // Dairy items with "Airfare" GL should be "5000"
    condition: (item) => {
      const cat = (item.category || '').trim();
      const gl = (item.glCode || '').trim();
      return cat === 'Dairy' && gl === 'Airfare';
    },
    targetGL: '5000',
    reason: 'Dairy items should not have Airfare GL code',
  },
];

// ============================================================
// DETERMINE TARGET CATEGORY + GL
// ============================================================

function determineTarget(itemDescription, vendorName) {
  const lowerDesc = (itemDescription || '').toLowerCase();
  const lowerVendor = (vendorName || '').trim();

  // Check vendor rules first (highest priority)
  for (const rule of VENDOR_RULES) {
    for (const vendor of rule.vendors) {
      if (lowerVendor === vendor || lowerVendor.toLowerCase() === vendor.toLowerCase()) {
        return {
          category: rule.category,
          glCode: rule.glCode,
          matchType: 'vendor',
          matchValue: vendor,
        };
      }
    }
  }

  // Check keyword rules
  for (const rule of KEYWORD_RULES) {
    for (const kw of rule.keywords) {
      if (lowerDesc.includes(kw)) {
        return {
          category: rule.category,
          glCode: rule.glCode,
          matchType: 'keyword',
          matchValue: kw,
        };
      }
    }
  }

  return null; // No match, keep as is
}

// ============================================================
// PARSE xtraCHEF EXPORT CSV
// ============================================================

function parseExportCSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`  Export file not found: ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  // Find the header line (contains "Item Description")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].includes('Item Description')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.log('  Could not find header row in export CSV.');
    return [];
  }

  // Parse header
  const headers = parseCSVLine(lines[headerIdx]);
  const descIdx = headers.findIndex(h => h.includes('Item Description'));
  const vendorIdx = headers.findIndex(h => h.includes('Vendor Name'));
  const catIdx = headers.findIndex(h => h.includes('Category'));
  const glIdx = headers.findIndex(h => h.includes('GL Code'));
  const codeIdx = headers.findIndex(h => h.includes('Item Code'));

  const items = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < Math.max(descIdx, vendorIdx, catIdx, glIdx) + 1) continue;

    const currentCat = (fields[catIdx] || '').trim();

    // Only include items in source categories
    if (!SOURCE_CATEGORIES.some(sc => sc.trim() === currentCat.trim())) continue;

    const description = (fields[descIdx] || '').trim();
    const vendor = (fields[vendorIdx] || '').trim();
    const target = determineTarget(description, vendor);

    if (target) {
      items.push({
        description,
        vendor,
        itemCode: (fields[codeIdx] || '').trim(),
        currentCategory: currentCat,
        currentGL: (fields[glIdx] || '').trim(),
        targetCategory: target.category,
        targetGL: target.glCode,
        matchType: target.matchType,
        matchValue: target.matchValue,
      });
    }
  }

  return items;
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
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
  return fields;
}

// ============================================================
// PARSE AUDIT LOG CSV (original mode)
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

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);

    // Fields: Timestamp, Item, Vendor, Product, Category, GL_Code, Family_Unit, Status, Notes
    if (fields.length >= 8) {
      const item = {
        description: fields[1],
        vendor: fields[2],
        currentCategory: fields[4],
        currentGL: fields[5],
        status: fields[7],
      };

      if (item.status === 'APPROVED' && SOURCE_CATEGORIES.some(sc => sc.trim() === item.currentCategory.trim())) {
        const target = determineTarget(item.description, item.vendor);
        if (target) {
          item.targetCategory = target.category;
          item.targetGL = target.glCode;
          item.matchType = target.matchType;
          item.matchValue = target.matchValue;
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
  const header = 'Timestamp,Item,Vendor,Old_Category,New_Category,Old_GL,New_GL,Match_Type,Match_Value,Status,Notes\n';
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
    `"${(data.oldGL || '').replace(/"/g, '""')}"`,
    `"${(data.newGL || '').replace(/"/g, '""')}"`,
    `"${(data.matchType || '').replace(/"/g, '""')}"`,
    `"${(data.matchValue || '').replace(/"/g, '""')}"`,
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
  const searchInput = await page.$('input[placeholder*="Search"]');
  if (!searchInput) {
    console.log('  >> Search input not found');
    return false;
  }

  // Use first 20 chars to avoid truncation issues
  const searchTerm = itemDescription.substring(0, 20).trim();
  await searchInput.click({ clickCount: 3 });
  await searchInput.type(searchTerm, { delay: 30 });
  await delay(2000);

  const clicked = await page.evaluate((desc) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    let row = rows.find(r => {
      const cells = r.querySelectorAll('td');
      for (const cell of cells) {
        if (cell.textContent.trim() === desc) return true;
      }
      return false;
    });
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
// SET GL CODE ON ITEM DETAIL PAGE
// ============================================================

async function setGLCodeOnPage(page, glCode) {
  const result = await page.evaluate((targetGL) => {
    // Find the GL code input or select
    const inputs = Array.from(document.querySelectorAll('input'));
    const glInput = inputs.find(i => {
      const id = (i.id || '').toLowerCase();
      const name = (i.name || '').toLowerCase();
      const placeholder = (i.placeholder || '').toLowerCase();
      return id.includes('gl') || name.includes('gl') || placeholder.includes('gl');
    });

    if (glInput) {
      glInput.value = '';
      glInput.value = targetGL;
      glInput.dispatchEvent(new Event('input', { bubbles: true }));
      glInput.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, type: 'input' };
    }

    // Try select/combobox
    const selects = Array.from(document.querySelectorAll('select'));
    const glSelect = selects.find(s => {
      const id = (s.id || '').toLowerCase();
      const name = (s.name || '').toLowerCase();
      return id.includes('gl') || name.includes('gl');
    });

    if (glSelect) {
      const options = Array.from(glSelect.options);
      const match = options.find(o => o.text.trim() === targetGL || o.value === targetGL);
      if (match) {
        glSelect.value = match.value;
        glSelect.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, type: 'select', set: true };
      }
      return { found: true, type: 'select', set: false };
    }

    // Try combobox button
    const combos = Array.from(document.querySelectorAll('button[role="combobox"]'));
    const glCombo = combos.find(b => {
      const hint = b.getAttribute('hint') || '';
      const ariaLabel = b.getAttribute('aria-label') || '';
      const text = b.textContent.toLowerCase();
      return hint.toLowerCase().includes('gl') || ariaLabel.toLowerCase().includes('gl') || text.includes('gl');
    });

    if (glCombo) {
      glCombo.click();
      return { found: true, type: 'combobox' };
    }

    return { found: false };
  }, glCode);

  if (!result.found) {
    console.log('  >> GL code field not found');
    return false;
  }

  if (result.type === 'input') {
    await delay(500);
    // May need to select from dropdown that appears
    await delay(500);
    const selected = await page.evaluate((targetGL) => {
      const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"], .dropdown-item'));
      const match = options.find(o => o.textContent.trim().includes(targetGL));
      if (match) {
        match.click();
        return true;
      }
      return false;
    }, glCode);
    await delay(500);
    return true;
  }

  if (result.type === 'combobox') {
    await delay(800);
    const searchInput = await page.$('input[placeholder="Search..."]');
    if (searchInput) {
      await searchInput.type(glCode.substring(0, 6), { delay: 50 });
      await delay(800);
    }

    const optionClicked = await page.evaluate((gl) => {
      const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"]'));
      const match = options.find(o => o.textContent.trim().includes(gl));
      if (match) {
        match.click();
        return true;
      }
      return false;
    }, glCode);

    if (optionClicked) {
      await delay(CONFIG.delayAfterAction);
      return true;
    }

    await page.keyboard.press('Escape');
    await delay(300);
    console.log(`  >> GL code "${glCode}" not found in dropdown`);
    return false;
  }

  return result.set || false;
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
  const closed = await page.evaluate(() => {
    const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="close"]');
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
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

  await page.goto(CONFIG.itemLibraryUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);
  return true;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('==============================================');
  console.log('  xtraCHEF Category Cleanup v2.1');
  console.log('  Recategorize items from audit log or export');
  console.log('==============================================');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (preview only)' : 'LIVE (will update categories + GL codes)'}`);
  console.log(`  Source: ${USE_EXPORT ? 'xtraCHEF export CSV' : 'audit-log.csv'}`);
  console.log(`  Limit: ${LIMIT} items`);
  console.log(`  Pause: ${PAUSE_EACH ? 'Yes' : 'No'}`);
  console.log('==============================================\n');

  // Parse items
  let itemsToRecat;
  if (USE_EXPORT && EXPORT_FILE) {
    console.log(`Reading export file: ${EXPORT_FILE}`);
    itemsToRecat = parseExportCSV(EXPORT_FILE);
  } else {
    console.log('Reading audit log...');
    itemsToRecat = parseAuditLog(CONFIG.auditLogFile);
  }

  if (itemsToRecat.length === 0) {
    console.log('\nNo items need recategorization.');
    console.log('(Only items currently in "Food Purchases" that match a vendor or keyword rule will be recategorized.)\n');
    if (USE_EXPORT) {
      console.log('Tip: Make sure the export CSV has the correct format with headers:');
      console.log('  "Location Name","Vendor Name","Item Code","Item Description",...,"Category","GL Code",...\n');
    }
    return;
  }

  console.log(`\nFound ${itemsToRecat.length} items to recategorize:\n`);

  // Show preview grouped by target category
  const categoryGroups = {};
  for (const item of itemsToRecat) {
    if (!categoryGroups[item.targetCategory]) categoryGroups[item.targetCategory] = [];
    categoryGroups[item.targetCategory].push(item);
  }

  for (const [cat, items] of Object.entries(categoryGroups)) {
    const glCode = items[0].targetGL || '(no change)';
    console.log(`  ${cat} | GL: ${glCode} (${items.length} items):`);
    for (const item of items.slice(0, 5)) {
      const matchInfo = item.matchType === 'vendor' ? `vendor: ${item.matchValue}` : `keyword: "${item.matchValue}"`;
      console.log(`    - ${item.description} [${matchInfo}]`);
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
  console.log('  This will update categories AND GL codes.');
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
    console.log(`  Current:  ${item.currentCategory} | GL: ${item.currentGL}`);
    console.log(`  Target:   ${item.targetCategory} | GL: ${item.targetGL}`);
    console.log(`  Match:    ${item.matchType}: ${item.matchValue}`);

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
          oldGL: item.currentGL,
          newGL: item.targetGL,
          matchType: item.matchType,
          matchValue: item.matchValue,
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
          oldGL: item.currentGL,
          newGL: item.targetGL,
          matchType: item.matchType,
          matchValue: item.matchValue,
          status: 'CAT_NOT_SET',
          notes: 'Category dropdown option not found',
        });
        await closeItemDetail(page);
        continue;
      }

      // Set the GL code if specified
      if (item.targetGL && item.targetGL !== item.currentGL) {
        console.log(`  >> Setting GL code to: ${item.targetGL}`);
        const glSet = await setGLCodeOnPage(page, item.targetGL);
        if (!glSet) {
          console.log(`  >> Warning: Could not set GL code, saving category change only`);
        }
      }

      // Save
      await clickSave(page);

      console.log(`  >> UPDATED: ${item.currentCategory} -> ${item.targetCategory} | GL: ${item.currentGL} -> ${item.targetGL}`);
      updated++;
      logRecat(CONFIG.recatLogFile, {
        item: item.description,
        vendor: item.vendor,
        oldCategory: item.currentCategory,
        newCategory: item.targetCategory,
        oldGL: item.currentGL,
        newGL: item.targetGL,
        matchType: item.matchType,
        matchValue: item.matchValue,
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
        oldGL: item.currentGL,
        newGL: item.targetGL,
        matchType: item.matchType,
        matchValue: item.matchValue,
        status: 'ERROR',
        notes: error.message.substring(0, 100),
      });

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
