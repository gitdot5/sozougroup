# xtraCHEF Inventory Processor v3.6

Automates processing of TO REVIEW items in xtraCHEF for Celestia + Ishin.

## Scripts

**process-items.js** (v3.6) - Main processor. Opens xtraCHEF Item Library, filters TO REVIEW items, fills required fields, sets GL codes and categories, and approves items automatically.

**recategorize-items.js** (v1.0) - Cleanup script. Reads audit-log.csv from a processing run and recategorizes items that were set to "Food Purchases" but should be Cleaning Supplies, Bar Supplies, or Non-Food Items based on keyword matching.

## What it does

For each TO REVIEW item, the script:
1. Reads the item description and vendor
2. Sets Category to "Food Purchases" (or "Non-Food Items" for supplies)
3. Sets GL Code to 5000 (Celestia) or 5001 (Ishin) for Japanese fish
4. Creates or assigns a product with a clean name
5. Sets family unit (Weight/Volume/Each) based on item type
6. Fills missing Unit and Inventory Unit fields
7. Clicks Approve
8. Detects already-approved items and skips them
9. Handles batch transitions (item 10 of 10 to next invoice)

Items it can't handle get logged to `flagged-items.csv` for manual review.

## Setup (one time)

```
npm install
```

If you don't have Node.js, install it first: https://nodejs.org (download the LTS version)

## How to run

### Step 1: Dry run first (RECOMMENDED)

This reads the first 10 items and shows what the script WOULD do. Nothing is changed.

```
npm run dry-run
```

A Chrome window opens. Log in to xtraCHEF manually, then press ENTER in the terminal. The script reads each item and prints the planned actions. Review the `audit-log.csv` to verify the decisions look correct.

### Step 2: Live run with pause (RECOMMENDED for first time)

Processes items one at a time. You press ENTER after each one to continue.

```
npm run start-pause
```

This lets you watch each item get processed and stop if anything looks wrong.

### Step 3: Full auto run

Once you trust the output, run it fully automated:

```
npm start
```

Or limit to a specific number of items:

```
npm run start-10    # Process 10 items
npm run start-50    # Process 50 items
```

Or set a custom limit:

```
node process-items.js --limit 100
```

### Step 4: Recategorize (after main run)

Preview what would change:

```
node recategorize-items.js --dry-run
```

Run live:

```
node recategorize-items.js
```

Step through each item:

```
node recategorize-items.js --pause
```

## Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Read only, no changes made |
| `--pause` | Pause after each item for review |
| `--limit N` | Process at most N items |

## Safety features

1. **Dry run mode**: `--dry-run` flag reads items without making any changes
2. **Pause mode**: `--pause` flag stops after each item for your review
3. **Item limit**: `--limit N` caps how many items are processed per run
4. **Audit log**: Every action is logged to `audit-log.csv`
5. **Flagged items**: Items the script can't handle go to `flagged-items.csv`
6. **Error screenshots**: If something fails, a screenshot is saved for debugging
7. **Manual login**: You always log in yourself (script never touches credentials)
8. **Confirmation prompt**: Before live processing starts, you must press ENTER to confirm
9. **Max 3 consecutive errors**: Script stops automatically if it hits 3 errors in a row
10. **Already-approved detection**: Skips items that are already approved
11. **Batch transition**: Automatically handles end-of-batch and loads next invoice

## Business rules

| Rule | Value |
|------|-------|
| Default GL Code | 5000 (Celestia) |
| Japanese fish GL | 5001 (Ishin) |
| Default Category | Food Purchases |
| Non-food Category | Non-Food Items |
| Japanese vendors | East Sea Trading, Ohta Foods, True World Foods, Atlanta Mutual Trading, JFC |
| Family unit (solids) | Weight |
| Family unit (liquids) | Volume |
| Family unit (supplies) | Each |

## Output files

| File | Purpose |
|------|---------|
| `audit-log.csv` | Every item processed with timestamp, decisions, and status |
| `flagged-items.csv` | Items that need manual review |
| `recat-log.csv` | Items successfully recategorized |
| `recat-errors.csv` | Items that failed recategorization |
| `error-screenshot-*.png` | Screenshots captured on errors |

## Troubleshooting

**Script can't find items**: Make sure you're on the correct business (Ishin LLC) after login.

**Cloudflare keeps blocking**: The script opens a real Chrome window. You solve the captcha manually, then the script takes over.

**"No TO REVIEW items found"**: All items may already be processed, or the filter didn't apply. Check the item library manually.

**Script stops with errors**: Check the error screenshot. Common causes: page didn't load, element not found, network timeout. Just re-run the script.

**"Already APPROVED, skipping"**: The item was previously approved. The script skips it and moves to the next one.

**Stuck on last item**: v3.6 handles this automatically by detecting last-item-in-batch and transitioning to the next invoice.
