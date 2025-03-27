import { Page, expect, request, test } from "@playwright/test";
import fs from "fs";
import path from "path";

import dict from "../../src/i18n/i18n";
import { UTXO } from "../../src/utils/blockchain";
import {
    decodeLiquidRawTransaction,
    elementsSendToAddress,
    generateLiquidBlock,
    getBolt12Offer,
    getLiquidAddress,
    setFailedToPay,
} from "../utils";

const setupSwapAssets = async (page: Page) => {
    await page.locator(".arrow-down").first().click();
    await page.getByTestId("select-L-BTC").click();
    await page
        .locator(
            "div:nth-child(3) > .asset-wrap > .asset > .asset-selection > .arrow-down",
        )
        .click();
    await page.getByTestId("select-LN").click();
};

const fillSwapDetails = async (page: Page) => {
    await page.getByTestId("invoice").fill(await getBolt12Offer());
    await page.getByTestId("sendAmount").fill("0.005");
    await page.getByTestId("create-swap-button").click();
};

const createAndVerifySwap = async (page: Page, rescueFile: string) => {
    await page.goto("/");
    await setupSwapAssets(page);
    await fillSwapDetails(page);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: dict.en.download_new_key }).click();
    await (await downloadPromise).saveAs(rescueFile);

    await page.getByTestId("rescueFileUpload").setInputFiles(rescueFile);
    await page.getByText("address").click();
};

const getCurrentSwapId = (page: Page) => {
    const url = new URL(page.url());
    return url.pathname.split("/").pop();
};

const waitForUTXOsInMempool = async (address: string, amount: number) => {
    const requestContext = request.newContext();
    await expect
        .poll(
            async () => {
                const res = await (
                    await requestContext
                ).get(`http://localhost:4003/api/address/${address}/utxo`);

                const utxos = (await res.json()) as UTXO[];
                return utxos.length === amount;
            },
            { timeout: 10_000 },
        )
        .toBe(true);
};

const navigateToSwapDetails = async (page: Page, swapId: string) => {
    await page.getByRole("link", { name: "Refund" }).click();
    const swapItem = page.locator(`div[data-testid='swaplist-item-${swapId}']`);
    await expect(page.getByTestId("loading-spinner")).not.toBeVisible();
    await expect(swapItem.getByRole("link", { name: "Refund" })).toBeVisible();
    await swapItem.click();
};

const validateRefundTxInputs = async (page: Page, utxos: number) => {
    const refundRequest = await page.waitForRequest((req) =>
        req.url().includes("/refund"),
    );
    const broadcastedTx = JSON.parse(refundRequest.postData() || "{}");

    const decodedTx = await decodeLiquidRawTransaction(
        broadcastedTx.transaction,
    );
    const tx = JSON.parse(decodedTx);

    expect(tx.vin.length).toBe(utxos);
};

test.describe("Refund", () => {
    const refundFileJson = path.join(__dirname, "rescue.json");

    test.beforeEach(async () => {
        await generateLiquidBlock();
    });

    test.afterEach(() => {
        if (fs.existsSync(refundFileJson)) {
            fs.unlinkSync(refundFileJson);
        }
    });

    test("Refunds all UTXOs of `invoice.failedToPay`", async ({ page }) => {
        await createAndVerifySwap(page, refundFileJson);

        const swapId = getCurrentSwapId(page);

        const address = await page.evaluate(() => {
            return navigator.clipboard.readText();
        });
        const amount = 0.005;
        const utxoCount = 3;

        await setFailedToPay(swapId);

        await elementsSendToAddress(address, amount);
        await elementsSendToAddress(address, amount);

        await waitForUTXOsInMempool(address, utxoCount);

        await navigateToSwapDetails(page, swapId);

        await expect(page.getByText("invoice.failedToPay")).toBeVisible();
        await page.getByTestId("refundAddress").fill(await getLiquidAddress());
        await page.getByTestId("refundButton").click();

        // Validate that the UTXOs are refunded on the same transaction
        await validateRefundTxInputs(page, utxoCount);

        const refundTxLink = page.getByText("open refund transaction");
        const txId = (await refundTxLink.getAttribute("href")).split("/").pop();

        expect(txId).toBeDefined();
    });

    test("Refunds all UTXOs of `transaction.lockupFailed`", async ({
        page,
    }) => {
        await createAndVerifySwap(page, refundFileJson);

        const swapId = getCurrentSwapId(page);

        const address = await page.evaluate(() => {
            return navigator.clipboard.readText();
        });
        const amount = 0.01;
        const utxoCount = 2;

        // Pay swap with incorrect amount & pay additional UTXO
        await elementsSendToAddress(address, amount);
        await elementsSendToAddress(address, amount);

        await waitForUTXOsInMempool(address, utxoCount);

        await navigateToSwapDetails(page, swapId);

        await expect(page.getByText("transaction.lockupFailed")).toBeVisible();
        await page.getByTestId("refundAddress").fill(await getLiquidAddress());
        await page.getByTestId("refundButton").click();

        // Validate that the UTXOs are refunded on the same transaction
        await validateRefundTxInputs(page, utxoCount);

        const refundTxLink = page.getByText("open refund transaction");
        const txId = (await refundTxLink.getAttribute("href")).split("/").pop();

        expect(txId).toBeDefined();
    });
});
