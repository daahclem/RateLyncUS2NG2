require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function getOriginConfig(origin) {
  const map = {
    US: {
      currency: "USD",
      countryName: "United States",
      countrySearch: "united states",
      countryCode2: "US",
      countryCode3: "USA",
      sendingParam: "US",
      localePath: "en-us",
    },
    GB: {
      currency: "GBP",
      countryName: "United Kingdom",
      countrySearch: "united kingdom",
      countryCode2: "GB",
      countryCode3: "GBR",
      sendingParam: "GB",
      localePath: "en-gb",
    },
  };

  return map[origin] || map.US;
}

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "NGN";
}

function destinationCountryName(destination) {
  if (destination === "GH") return "Ghana";
  if (destination === "NG") return "Nigeria";
  return "Nigeria";
}

function destinationSearch(destination) {
  if (destination === "GH") return "gh";
  if (destination === "NG") return "ng";
  return "ng";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText() {
  
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, fromCurrency, toCurrency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*1\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${toCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100000) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "USD") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
    new RegExp(`Fee:?\\s*([0-9.]+)`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const originCfg = getOriginConfig(source.origin);
  const fromCurrency = originCfg.currency;
  const toCurrency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, fromCurrency, toCurrency);
  const fee = extractFeeFromText(bodyText, fromCurrency);
  let amountReceived = extractAmountReceivedFromText(bodyText, toCurrency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}


async function handleOaPay(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destCurrency = currencyForDestination(source.destination);
  const destName = destinationCountryName(source.destination);

  await page.goto("https://www.oapay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByText("GBP").nth(1).click().catch(async () => {
    await page.getByText(/GBP|USD/i).nth(1).click().catch(() => {});
  });
  await page.getByText("USD United States of America").click().catch(async () => {
    await page.getByText(/USD United States of America|USD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  await page.getByText("GHS").nth(2).click().catch(async () => {
    await page.getByText(/GHS|NGN/i).nth(2).click().catch(() => {});
  });
  await page.getByText(new RegExp(`${destCurrency} ${destName}|${destName}|${destCurrency}`, "i")).click().catch(async () => {
    await page.getByText(new RegExp(destCurrency, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  const receiveBox = page.getByRole("textbox", { name: /Recipient Receives/i });
  await receiveBox.waitFor({ timeout: 15000 });
  await receiveBox.click({ force: true });
  await receiveBox.press("Control+A").catch(() => {});
  await receiveBox.fill("100.00");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}\\s*\\(no charges\\)`, "i"),
    new RegExp(`1\\.00\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, destCurrency);
  }

  if (!rate) {
    const looseMatches = bodyText.match(/\b([1-9]\d{0,3}\.\d{2,5})\b/g) || [];
    const candidates = looseMatches
      .map((v) => parseFloat(v))
      .filter((v) => !Number.isNaN(v) && v > 0 && v < 100000);

    if (candidates.length) {
      rate = Number(candidates[0].toFixed(6));
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract OaPay rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleOhentPay(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destCurrency = currencyForDestination(source.destination);
  const destName = destinationCountryName(source.destination);

  const path =
    source.destination === "NG"
      ? "https://www.ohentpay.com/send-money/send-money-to-nigeria"
      : "https://www.ohentpay.com/send-money/send-money-to-ghana";

  await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("combobox").filter({ hasText: "GBP" }).click().catch(async () => {
    await page.getByRole("combobox").filter({ hasText: /USD|GBP|Select currency/i }).first().click().catch(() => {});
  });

  await page.getByText("United States Dollar (USD)").click().catch(async () => {
    await page.getByText(/United States Dollar \(USD\)|USD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  await page.getByRole("combobox").filter({ hasText: /GHS|NGN/i }).click().catch(() => {});
  await page.getByText(new RegExp(`${destName}.*${destCurrency}|${destCurrency}`, "i")).click().catch(async () => {
    await page.getByText(new RegExp(destCurrency, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  await page.getByRole("combobox").filter({ hasText: "Select currency" }).click().catch(() => {});
  await page.getByText(new RegExp(`${destName}.*${destCurrency}|${destCurrency}`, "i")).click().catch(() => {});

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`Exchange rate\\s*1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, destCurrency);
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Ohent Pay rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePaysend(page, source) {
  await page.goto(
    "https://paysend.com/en-gb/send-money/from-the-united-states-of-america-to-nigeria?send=usd",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }
  );

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "Accept All Cookies" }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const rateText = await page
    .getByText(/Today[’']s rate:\s*1\.00\s*USD\s*=\s*[0-9,]+/i)
    .first()
    .innerText()
    .catch(() => "");

  const bodyText = `${rateText}\n${await page.locator("body").innerText()}`;
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const cleaned = bodyText
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .replace(/Today’s/g, "Todays")
    .replace(/Today's/g, "Todays");

  const patterns = [
    /Todays rate:\s*1\.00\s*USD\s*=\s*([0-9]+(?:\.\d+)?)/i,
    /1\.00\s*USD\s*=\s*([0-9]+(?:\.\d+)?)/i,
    /1\s*USD\s*=\s*([0-9]+(?:\.\d+)?)/i,
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 100 && candidate < 10000) {
      rate = candidate;
      break;
    }
  }

  await page.locator("a").filter({ hasText: /^OK$/ }).click({ timeout: 2500 }).catch(() => {});

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Paysend rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePesaCo(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destCurrency = currencyForDestination(source.destination);

  await page.goto("https://www.pesa.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#send-option").click().catch(() => {});
  await page.getByText(originCfg.currency).first().click().catch(async () => {
    await page.getByText(new RegExp(`^${originCfg.currency}$`, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  await page.locator("#receive-option").getByText(/CAD|GHS|NGN/i).click().catch(async () => {
    await page.locator("#receive-option").click().catch(() => {});
  });
  await page.getByText(destCurrency).nth(1).click().catch(async () => {
    await page.getByText(new RegExp(`^${destCurrency}$`, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.locator("#rateValue").click().catch(() => {});

  const sendInput = page.locator("#sendAmount");
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("100");

  await page.waitForTimeout(1500);

  await page.locator("#receiveAmount").click().catch(() => {});
  await page.locator("#receiveAmount").click().catch(() => {});
  await page.locator("#receiveAmount").click().catch(() => {});
  await page.locator("#rateValue").click().catch(() => {});
  await page.locator("#send-value").click().catch(() => {});
  await page.locator("#rateValue").click().catch(() => {});

  await page.waitForTimeout(5000);

  let rateText = "";
  const rateLocator = page.locator("#rateValue");
  if (await rateLocator.count()) {
    rateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const receiveAmountText = await page.locator("#receiveAmount").inputValue().catch(() => "");
  const bodyText = await page.locator("body").innerText();
  const combinedText = `${rateText}\nRECEIVE_AMOUNT=${receiveAmountText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;
  const primaryPatterns = [
    new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${destCurrency}`, "i"),
  ];

  for (const regex of primaryPatterns) {
    const match = rateText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const received = parseLocaleNumber(receiveAmountText);
    if (received && received > 0) {
      rate = Number((received / 100).toFixed(6));
    }
  }

  if (!rate) {
    const patterns = [
      new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
      new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    ];

    for (const regex of patterns) {
      const match = combinedText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1]);
      if (candidate && candidate > 0 && candidate < 100000) {
        rate = Number(candidate.toFixed(6));
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Pesa.co rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
    quoted_amount_received: parseLocaleNumber(receiveAmountText),
  });
}

async function handleULink(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destCurrency = currencyForDestination(source.destination);
  const path = source.destination === "NG" ? "nigeria" : "ghana";

  await page.goto(`https://ulink.com/send-money/${path}/`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  const sendInput = page.locator("#amountToSend");
  await sendInput.waitFor({ timeout: 15000 });
  await sendInput.click({ force: true });
  await sendInput.click({ force: true });
  await sendInput.fill("100");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`uLink daily rate\\s*1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)`, "i"),
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100000) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract uLink rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleXE(page, source) {
  await page.goto("https://www.xe.com/send-money/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  await page.getByRole("button", { name: /^Accept$/i })
    .click({ timeout: 8000 })
    .catch(() => {});

  // Destination country must be United States for US->NG corridor
  await page.getByRole("button", { name: /Destination country/i })
    .click({ timeout: 20000 });

  await page.getByPlaceholder("Filter countries...")
    .fill("u", { timeout: 10000 });

  await page.waitForTimeout(1000);

  await page.getByRole("option", { name: /US United States/i })
    .click({ timeout: 15000 });

  await page.waitForTimeout(1500);

  // Sending currency = USD
  await page.getByRole("button", { name: /GBP GBP|USD USD|CAD CAD/i })
    .first()
    .click({ timeout: 20000 });

  await page.getByRole("option", { name: /USD USD US Dollar/i })
    .click({ timeout: 15000 });

  await page.waitForTimeout(1500);

  // Receiving currency = NGN
  await page.getByText(/Recipient gets\$USD/i)
    .click({ timeout: 15000 })
    .catch(() => {});

  await page.locator("#receiving-currency")
    .click({ timeout: 20000 });

  await page.getByPlaceholder("Search currencies...")
    .fill("ngn", { timeout: 10000 });

  await page.waitForTimeout(1000);

  await page.getByRole("option", { name: /NGN NGN Nigerian Naira/i })
    .click({ timeout: 15000 });

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /USD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /1\s*USD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);

    if (candidate && candidate >= 800 && candidate <= 2500) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract live XE USD->NGN rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    verification_status: "verified_from_live_xe_send_money_widget",
    source_url: "https://www.xe.com/send-money/",
  });
}


async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "OaPay") payload = await handleOaPay(page, source);
  
    else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
    else if (source.provider === "Ohent Pay") payload = await handleOhentPay(page, source);
    else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
      else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
    else if (source.provider === "uLink") payload = await handleULink(page, source);
    else if (source.provider === "XE") payload = await handleXE(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-us-ng2.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
