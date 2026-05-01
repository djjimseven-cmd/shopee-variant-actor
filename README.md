# Shopee Variant Actor

Apify Playwright actor to crawl Shopee product pages at variant level.

## Input

Use [input_schema.json](/Users/quanghavu/Documents/APP%20TI%CC%81NH%20GIA%CC%81%20SHOPEE/apify/shopee-variant-actor/input_schema.json).

## Output

- Pushes one dataset row per variant
- Stores `OUTPUT` key-value record as `{ items: [...] }`
- Optionally POSTs `{ items: [...] }` to Base44 webhook when `webhook_url` is provided

## Notes

- This actor uses Playwright because Shopee often renders real variant prices only after selecting combinations.
- It first tries to parse structured variant data from page scripts.
- If structured data is not available, it falls back to DOM-based extraction.
- Some products may block crawling or hide stock; in those cases rows are partial by design.
