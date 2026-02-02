import { Actor } from 'apify';
import puppeteer from 'puppeteer';
import { setTimeout as sleep } from 'timers/promises';

await Actor.init();

const input = await Actor.getInput();
const {
    searchTerms = ['club de tenis'],
    location = 'Colombia',
    maxResultsPerSearch = 200,
    language = 'es',
    includeDetails = true,
} = input || {};

console.log(`🚀 Google Maps Scraper iniciado`);
console.log(`📍 Búsquedas: ${searchTerms.join(', ')}`);
console.log(`🌎 Ubicación: ${location}`);
console.log(`📊 Max por búsqueda: ${maxResultsPerSearch}`);
console.log(`📋 Detalles completos: ${includeDetails}`);

const browser = await puppeteer.launch({
    headless: 'new',
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--lang=' + language,
    ],
});

const dataset = await Actor.openDataset();
const seenPlaceIds = new Set();
let totalExtracted = 0;

/**
 * Build Google Maps search URL
 */
function buildSearchUrl(term, loc) {
    const query = encodeURIComponent(`${term} in ${loc}`);
    return `https://www.google.com/maps/search/${query}/?hl=${language}`;
}

/**
 * Accept Google consent if shown
 */
async function handleConsent(page) {
    try {
        const consentBtn = await page.$('button[aria-label*="Accept"], form[action*="consent"] button');
        if (consentBtn) {
            await consentBtn.click();
            await sleep(2000);
            console.log('  ✅ Consent accepted');
        }
    } catch (e) {
        // No consent needed
    }
}

/**
 * Scroll the results panel to load more items
 */
async function scrollResults(page, maxResults) {
    let previousCount = 0;
    let stableCount = 0;
    const maxStable = 5; // stop after 5 scrolls with no new results

    for (let i = 0; i < 100; i++) {
        const currentCount = await page.evaluate(() => {
            const items = document.querySelectorAll('div[role="feed"] > div > div > a[href*="/maps/place/"]');
            return items.length;
        });

        console.log(`  📜 Scroll ${i + 1}: ${currentCount} resultados cargados`);

        if (currentCount >= maxResults) {
            console.log(`  ✅ Alcanzado máximo de ${maxResults}`);
            break;
        }

        if (currentCount === previousCount) {
            stableCount++;
            if (stableCount >= maxStable) {
                // Check if we hit "end of results"
                const endOfList = await page.evaluate(() => {
                    const spans = document.querySelectorAll('span');
                    for (const s of spans) {
                        if (s.textContent.includes("You've reached the end") ||
                            s.textContent.includes('Has llegado al final') ||
                            s.textContent.includes('No hay más resultados')) {
                            return true;
                        }
                    }
                    return false;
                });
                if (endOfList) {
                    console.log(`  🏁 Fin de resultados`);
                    break;
                }
                console.log(`  ⚠️ Sin nuevos resultados después de ${maxStable} scrolls`);
                break;
            }
        } else {
            stableCount = 0;
        }

        previousCount = currentCount;

        // Scroll the feed panel
        await page.evaluate(() => {
            const feed = document.querySelector('div[role="feed"]');
            if (feed) {
                feed.scrollTop = feed.scrollHeight;
            } else {
                // Fallback: scroll the results container
                const container = document.querySelector('div[role="main"]');
                if (container) container.scrollTop = container.scrollHeight;
            }
        });

        await sleep(1500 + Math.random() * 1000);
    }
}

/**
 * Extract basic info from search results list
 */
async function extractSearchResults(page) {
    return await page.evaluate(() => {
        const results = [];
        const items = document.querySelectorAll('div[role="feed"] > div > div > a[href*="/maps/place/"]');

        for (const item of items) {
            const href = item.getAttribute('href') || '';
            const ariaLabel = item.getAttribute('aria-label') || '';

            // Extract place ID from URL
            const placeIdMatch = href.match(/!1s([^!]+)/);
            const placeId = placeIdMatch ? placeIdMatch[1] : href;

            // Extract coordinates from URL
            const coordMatch = href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
            const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
            const lng = coordMatch ? parseFloat(coordMatch[2]) : null;

            // Try to get rating and reviews from the card
            const parent = item.closest('div');
            const allText = parent ? parent.textContent : '';

            const ratingMatch = allText.match(/(\d[.,]\d)\s*\(/);
            const reviewMatch = allText.match(/\((\d[\d.,]*)\)/);

            results.push({
                title: ariaLabel || 'Sin nombre',
                url: href,
                placeId,
                lat,
                lng,
                ratingFromList: ratingMatch ? parseFloat(ratingMatch[1].replace(',', '.')) : null,
                reviewCountFromList: reviewMatch ? parseInt(reviewMatch[1].replace(/[.,]/g, '')) : null,
            });
        }
        return results;
    });
}

/**
 * Get detailed info by clicking on a place
 */
async function getPlaceDetails(page, placeUrl) {
    try {
        await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);

        const details = await page.evaluate(() => {
            const result = {};

            // Title
            const titleEl = document.querySelector('h1');
            result.title = titleEl ? titleEl.textContent.trim() : '';

            // Category
            const categoryEl = document.querySelector('button[jsaction*="category"]');
            result.category = categoryEl ? categoryEl.textContent.trim() : '';

            // Address
            const addressEl = document.querySelector('button[data-item-id="address"] div.fontBodyMedium');
            if (!addressEl) {
                // Fallback: look for address in aria-label
                const allButtons = document.querySelectorAll('button[aria-label]');
                for (const btn of allButtons) {
                    const label = btn.getAttribute('aria-label') || '';
                    if (label.includes('Dirección:') || label.includes('Address:')) {
                        result.address = label.replace(/^(Dirección:|Address:)\s*/, '');
                        break;
                    }
                }
            } else {
                result.address = addressEl.textContent.trim();
            }
            if (!result.address) {
                const addrBtn = document.querySelector('[data-item-id="address"]');
                result.address = addrBtn ? addrBtn.getAttribute('aria-label')?.replace(/^[^:]+:\s*/, '') : '';
            }

            // Phone
            const phoneBtn = document.querySelector('button[data-item-id*="phone"] div.fontBodyMedium');
            if (!phoneBtn) {
                const allButtons = document.querySelectorAll('button[aria-label]');
                for (const btn of allButtons) {
                    const label = btn.getAttribute('aria-label') || '';
                    if (label.includes('Teléfono:') || label.includes('Phone:')) {
                        result.phone = label.replace(/^(Teléfono:|Phone:)\s*/, '');
                        break;
                    }
                }
            } else {
                result.phone = phoneBtn.textContent.trim();
            }
            if (!result.phone) {
                const phoneEl = document.querySelector('[data-item-id*="phone"]');
                result.phone = phoneEl ? phoneEl.getAttribute('aria-label')?.replace(/^[^:]+:\s*/, '') : '';
            }

            // Website
            const websiteBtn = document.querySelector('a[data-item-id="authority"] div.fontBodyMedium');
            if (!websiteBtn) {
                const allLinks = document.querySelectorAll('a[aria-label]');
                for (const link of allLinks) {
                    const label = link.getAttribute('aria-label') || '';
                    if (label.includes('Sitio web:') || label.includes('Website:')) {
                        result.website = link.href || label.replace(/^[^:]+:\s*/, '');
                        break;
                    }
                }
            } else {
                result.website = websiteBtn.textContent.trim();
            }
            if (!result.website) {
                const webEl = document.querySelector('[data-item-id="authority"]');
                result.website = webEl ? (webEl.href || webEl.getAttribute('aria-label')?.replace(/^[^:]+:\s*/, '')) : '';
            }

            // Rating
            const ratingEl = document.querySelector('div.fontDisplayLarge');
            result.rating = ratingEl ? parseFloat(ratingEl.textContent.replace(',', '.')) : null;

            // Review count
            const reviewEl = document.querySelector('span[aria-label*="reseñas"], span[aria-label*="reviews"]');
            if (reviewEl) {
                const match = reviewEl.getAttribute('aria-label').match(/(\d[\d.,]*)/);
                result.reviewCount = match ? parseInt(match[1].replace(/[.,]/g, '')) : 0;
            }

            // Opening hours
            const hoursEl = document.querySelector('div[aria-label*="horario"], div[aria-label*="hours"]');
            result.openingHours = hoursEl ? hoursEl.getAttribute('aria-label') : '';

            // Plus code / neighborhood
            const plusCodeEl = document.querySelector('[data-item-id="plus_code"]');
            result.plusCode = plusCodeEl ? plusCodeEl.getAttribute('aria-label')?.replace(/^[^:]+:\s*/, '') : '';

            return result;
        });

        return details;
    } catch (err) {
        console.log(`  ⚠️ Error obteniendo detalles: ${err.message}`);
        return null;
    }
}

/**
 * Extract city from address string
 */
function extractCity(address) {
    if (!address) return '';
    // Colombian addresses usually have city after the last comma
    const parts = address.split(',').map(p => p.trim());
    // Try to find a known pattern: "City, Department, Colombia"
    if (parts.length >= 3) return parts[parts.length - 3];
    if (parts.length >= 2) return parts[parts.length - 2];
    return parts[parts.length - 1] || '';
}

// ===================== MAIN LOOP =====================
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    for (const term of searchTerms) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔍 Buscando: "${term}" en ${location}`);
        console.log(`${'='.repeat(60)}`);

        const url = buildSearchUrl(term, location);
        console.log(`  🌐 URL: ${url}`);

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        // Handle consent
        await handleConsent(page);

        // Wait for results to load
        try {
            await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
        } catch (e) {
            console.log(`  ⚠️ No se encontró panel de resultados, puede que no haya resultados`);
            // Take screenshot for debugging
            const kvStore = await Actor.openKeyValueStore();
            const screenshot = await page.screenshot({ fullPage: false });
            await kvStore.setValue(`no-results-${term.replace(/\s+/g, '-')}`, screenshot, { contentType: 'image/png' });
            continue;
        }

        // Scroll to load all results
        await scrollResults(page, maxResultsPerSearch);

        // Extract basic info from list
        const searchResults = await extractSearchResults(page);
        console.log(`  📋 ${searchResults.length} resultados encontrados`);

        let newCount = 0;
        for (const result of searchResults) {
            // Deduplicate
            if (seenPlaceIds.has(result.placeId)) {
                continue;
            }
            seenPlaceIds.add(result.placeId);
            newCount++;

            let placeData = {
                searchTerm: term,
                title: result.title,
                googleMapsUrl: result.url.startsWith('http') ? result.url : `https://www.google.com${result.url}`,
                lat: result.lat,
                lng: result.lng,
                rating: result.ratingFromList,
                reviewCount: result.reviewCountFromList,
            };

            // Get full details if enabled
            if (includeDetails && result.url) {
                const fullUrl = result.url.startsWith('http') ? result.url : `https://www.google.com${result.url}`;
                console.log(`  📍 [${totalExtracted + 1}] ${result.title}`);
                const details = await getPlaceDetails(page, fullUrl);

                if (details) {
                    placeData = {
                        ...placeData,
                        title: details.title || placeData.title,
                        category: details.category || '',
                        address: details.address || '',
                        city: extractCity(details.address),
                        phone: details.phone || '',
                        website: details.website || '',
                        rating: details.rating || placeData.rating,
                        reviewCount: details.reviewCount || placeData.reviewCount,
                        openingHours: details.openingHours || '',
                        plusCode: details.plusCode || '',
                    };
                }

                // Small delay to avoid rate limiting
                await sleep(500 + Math.random() * 500);
            }

            await dataset.pushData(placeData);
            totalExtracted++;

            if (totalExtracted % 10 === 0) {
                console.log(`  📊 Progreso: ${totalExtracted} lugares extraídos`);
            }
        }

        console.log(`  ✅ ${newCount} nuevos (${searchResults.length - newCount} duplicados)`);
    }

    // Final screenshot
    const kvStore = await Actor.openKeyValueStore();
    const finalScreenshot = await page.screenshot({ fullPage: false });
    await kvStore.setValue('final-screenshot', finalScreenshot, { contentType: 'image/png' });

    // Save summary
    await kvStore.setValue('OUTPUT', {
        success: true,
        totalExtracted,
        searchTerms,
        location,
        timestamp: new Date().toISOString(),
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ COMPLETADO: ${totalExtracted} lugares extraídos`);
    console.log(`${'='.repeat(60)}`);

} catch (err) {
    console.error(`❌ Error fatal: ${err.message}`);
    const kvStore = await Actor.openKeyValueStore();
    await kvStore.setValue('OUTPUT', {
        success: false,
        error: err.message,
        totalExtracted,
        timestamp: new Date().toISOString(),
    });
} finally {
    await browser.close();
}

await Actor.exit();
