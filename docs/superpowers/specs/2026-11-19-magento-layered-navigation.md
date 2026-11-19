# Magento layered navigation: what ThemeSeed changed, and what the importer still owes

Reported 2026-11-19 against Magento 2.4.9 / RetailStore, from a generated catalog of 36 products
across 5 categories: Magento built 26 filters for the category page and 25 of them had no
options. Price was the only filter that worked.

Two separate causes, in two separate repos.

## 1. `is_filterable` was never expressed — fixed here

Magento builds no layered-navigation facet for an attribute whose
`catalog_eav_attribute.is_filterable` is 0, and 0 is the default. `catalog.json` had no field
for it, so colour, size and material all landed at 0. The theme's filter sidebar was correct;
there was nothing to put in it.

`magento-content/1` now carries, on every attribute:

```json
{
  "code": "color",
  "input": "select",
  "global": true,
  "is_filterable": 1,
  "is_filterable_in_search": 1,
  "swatch": "visual",
  "options": [...]
}
```

- `is_filterable` — `0` none, `1` filterable with results, `2` always filterable. Magento's own
  three values, not a boolean, because `2` is a real setting a theme may want.
- `is_filterable_in_search` — `0` or `1`, for the search results page.

Both are optional in the schema and default to 0 there, matching Magento. Every attribute
**ThemeSeed generates** is written as 1: a demo catalog exists to show a storefront working, and
a listing page without filters is not that.

**The importer must write both columns to `catalog_eav_attribute`.** Until it does, nothing in
this change reaches the database. Note that Magento also wants the attribute added to the
category's filterable set and the EAV/catalog indexes reindexed before the facet appears.

## 2. Non-axis attribute values are dropped on import — not fixed here

`material`'s values were never written: `catalog_product_entity_int` had zero rows for it, while
`color` had 5595 and `size` 5537.

ThemeSeed's output was already correct. Axis values travel on `product.variants[].values` and
the importer reads that path. Non-axis values travel on `product.attributes`, and the importer
does not read that path at all — they are dropped silently.

```json
{
  "key": "lundy-single-origin",
  "type": "configurable",
  "attributes": { "roast_level": "dark", "origin": "colombia", "grind": ["filter"] },
  "axes": ["color", "size"],
  "variants": [{ "sku": "…", "values": { "color": "black", "size": "1kg" } }]
}
```

`product.attributes` maps an attribute code to **an option key for a select, or an array of
option keys for a multiselect** — the same keys declared in that attribute's `options`, never
option ids, which ThemeSeed cannot know. The importer resolves them the way it already resolves
axis option keys.

This is the entire remaining fix for the empty `material` facet. Setting `is_filterable` without
it leaves those facets filterable and empty, which is no better than hidden.

ThemeSeed now also guarantees **every product carries a value for every non-axis facet**, so no
facet can be empty for lack of data once the import path exists.

## 3. Facets now follow the trade — fixed here

The non-axis attributes used to be a single hard-coded `material` list taken from Luma, so a
coffee roastery's sidebar offered Cotton, Leather and Wool.

`TOPIC_PROFILES` in `src/providers/magento/catalog.ts` now carries the size scale, the size axis
label and the facets together, matched on `store.topic`:

| Topic                             | Size axis   | Facets                     |
| --------------------------------- | ----------- | -------------------------- |
| coffee / tea / food / bakery      | "Pack size" | Roast level, Origin, Grind |
| furniture / home decor / lighting | "Size"      | Material, Room             |
| jewellery / watches / accessories | "Length"    | Material, Gemstone         |
| anything else (apparel fallback)  | "Size"      | Material, Style            |

The size _scale_ was already topic-aware — a roastery's sizes have been 250 g / 500 g / 1 kg all
along, which is the "pack size already encoded in the SKU" from the report. Only the label was
borrowed from apparel.

Adding a trade means one entry in that table and nothing else.

### Still generic: the `color` axis

A roastery's sidebar will still offer Colour. Replacing an axis is a different change from
replacing a facet — axes drive the configurable parent/child structure and the swatch strip —
and it was deliberately left out of this pass. If it matters, the request can already override
it: `catalog.axes` in `magento-content-request/1` names the axes outright.
