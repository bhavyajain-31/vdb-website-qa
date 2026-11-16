// Daily monitoring tracker ("Shopify Demo Monitoring Tracker"). TC-26, TC-29 and TC-30 stay manual
// (checkout, contact form and newsletter submit real data), so they are listed but never run.
export interface TrackerDef { id: string; area: string; title: string; steps: string; expected: string; priority: string; manual: boolean }

export const TRACKER: TrackerDef[] = [
 {
  "id": "TC-01",
  "area": "Home",
  "title": "Home page loads",
  "steps": "Open shopify.vdbapp.com",
  "expected": "Loads in under 5 s; banner, \"Create your own ring now\" hero, product carousels and footer visible; no broken images",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-02",
  "area": "Navigation",
  "title": "Mega-menus open",
  "steps": "Hover/click Engagement Rings, Diamonds, Gemstones, Fine Jewelry",
  "expected": "Each menu opens with all sub-links; no empty panels",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-03",
  "area": "Navigation",
  "title": "Menu links resolve",
  "steps": "Click 1 link per menu column (e.g. Halo, Round, Ruby, Tennis Bracelets)",
  "expected": "Each opens a page with content, no 404 or blank page",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-04",
  "area": "Search",
  "title": "Keyword search",
  "steps": "Search \"halo ring\"",
  "expected": "Results list shows halo rings; clicking one opens its product page",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-05",
  "area": "Search",
  "title": "No-result search",
  "steps": "Search \"xyz123\"",
  "expected": "Friendly \"no results\" message, no error",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-06",
  "area": "Diamond Search",
  "title": "Natural diamonds load",
  "steps": "Diamonds → Natural → Search Diamonds",
  "expected": "Route to Search Form",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-07",
  "area": "Diamond Search",
  "title": "Filters work",
  "steps": "Apply shape Oval, carat 1–2, colour G–H, clarity VS1–VS2, price range",
  "expected": "Result count changes; every result matches the filters",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-08",
  "area": "Diamond Search",
  "title": "Sort and paging",
  "steps": "Sort by price low→high; go to page 2 / scroll to load more",
  "expected": "Order is correct; next set of stones loads",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-09",
  "area": "Diamond Search",
  "title": "Diamond detail",
  "steps": "Open any diamond",
  "expected": "Detail page shows specs (shape, carat, cut, colour, clarity), certificate link, media/360 view, price, Add to cart / Add to ring",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-10",
  "area": "Diamond Search",
  "title": "Lab-grown search",
  "steps": "Diamonds → Lab-Grown → Search Diamond",
  "expected": "Lab-grown results load; filters respond",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-11",
  "area": "Diamond Search",
  "title": "Shape shortcuts",
  "steps": "Click Round, Princess, Cushion, Emerald, Oval, Heart links",
  "expected": "Each opens search pre-filtered to that shape",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-12",
  "area": "Diamond Search",
  "title": "Colored diamonds",
  "steps": "Colored Natural → Yellow; Colored Lab-Grown → Pink",
  "expected": "Colour-filtered fancy diamonds load",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-13",
  "area": "Gemstone Search",
  "title": "Gemstones load and filter",
  "steps": "Gemstones → Ruby; then Shop by Shape → Oval",
  "expected": "Gemstones load with images and prices; filters apply",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-14",
  "area": "Ring Builder",
  "title": "Start with diamond",
  "steps": "Design Your Own Ring → Start with a Natural Diamond → pick a diamond → choose setting → pick metal and ring size",
  "expected": "Diamond and setting combine; ring preview and total price shown",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-15",
  "area": "Ring Builder",
  "title": "Start with setting",
  "steps": "Start with Setting → pick a setting and metal → choose diamond",
  "expected": "Only compatible diamonds offered; completed ring summary shown",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-16",
  "area": "Ring Builder",
  "title": "Lab-grown and gemstone starts",
  "steps": "Start with a Lab-Grown Diamond; Start with a Gemstone",
  "expected": "Each path reaches the setting step with the chosen stone kept",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-17",
  "area": "Ring Builder",
  "title": "Completed ring to cart",
  "steps": "Finish TC-14 → Add to cart",
  "expected": "Cart shows setting + stone (or one combined line) with correct total",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-18",
  "area": "3D Ring Builder",
  "title": "3D viewer works",
  "steps": "Open 3D Ring Builder / Start with 3D Setting; rotate, change metal and stone",
  "expected": "3D model renders, rotates smoothly, updates on each change",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-19",
  "area": "Quiz",
  "title": "Ring quiz completes",
  "steps": "Take our Quiz → answer all questions",
  "expected": "Recommendations page shows matching rings",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-20",
  "area": "Configurator",
  "title": "Configure Rings / Fine Jewelry",
  "steps": "Open Configure Rings and Configure Fine Jewelry; change options",
  "expected": "Image and price update with each option",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-21",
  "area": "Catalogue",
  "title": "Collection pages",
  "steps": "Open Solitaire, Yellow Gold, Stud Earrings, Tennis Bracelets, Pendants",
  "expected": "Products load with image, name, \"From\" price",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-22",
  "area": "Catalogue",
  "title": "Collection filter/sort",
  "steps": "On a collection, filter by metal and sort by price",
  "expected": "Products update correctly",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-23",
  "area": "Product page",
  "title": "Variant selection",
  "steps": "Open \"14K Rose Gold Round Halo engagement ring\"; change metal, carat, ring size",
  "expected": "Price and images update; Add to cart enabled",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-24",
  "area": "Product page",
  "title": "Sold-out handling",
  "steps": "Open a Sold-out wedding band",
  "expected": "Shows Sold out; Add to cart disabled",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-25",
  "area": "Cart",
  "title": "Add, update, remove",
  "steps": "Add a product; change quantity to 2; remove it",
  "expected": "Cart count, line total and estimated total update; empty cart message returns",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-26",
  "area": "Checkout",
  "title": "Checkout opens",
  "steps": "Cart → Check out; enter test email and US address",
  "expected": "Shopify checkout loads; shipping options and totals shown. Stop before payment.",
  "priority": "P1",
  "manual": true
 },
 {
  "id": "TC-29",
  "area": "Forms",
  "title": "\"Speak to our team\" form",
  "steps": "Open form; check fields and reCAPTCHA",
  "expected": "First/Last name, Company, Phone, Email, Comments and reCAPTCHA render; submit once a week with \"TEST – ignore\"",
  "priority": "P1",
  "manual": true
 },
 {
  "id": "TC-30",
  "area": "Forms",
  "title": "Newsletter sign-up",
  "steps": "Enter a test email, Sign up",
  "expected": "Success message shown",
  "priority": "P1",
  "manual": true
 },
 {
  "id": "TC-31",
  "area": "Content",
  "title": "Footer, FAQ, policies",
  "steps": "Open About, FAQ accordions, Refund, Privacy, Terms, social icons",
  "expected": "Pages load; FAQ expands; social links open in new tab",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-32",
  "area": "Mobile",
  "title": "Mobile smoke",
  "steps": "On a phone (or Chrome device mode 390 px): home, menu, Diamond Search, product page, cart",
  "expected": "Layout fits, menu opens, search and cart usable",
  "priority": "P1",
  "manual": false
 },
 {
  "id": "TC-33",
  "area": "Deeplink",
  "title": "Footer",
  "steps": "Click Create Ring with Natural Diamonds in the header, then repeat using the same link in the footer.",
  "expected": "Both links should navigate to the same correct page.",
  "priority": "P1",
  "manual": false
 }
];
