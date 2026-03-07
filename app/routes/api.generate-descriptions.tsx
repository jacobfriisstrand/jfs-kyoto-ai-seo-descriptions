import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { fetchProductById } from "../lib/shopify-products.server";
import { generateMultipleDescriptions } from "../lib/ai.server";
import prisma from "../db.server";
import { decrypt, isEncrypted } from "../lib/encryption.server";
import type { ProductDataField } from "../lib/shopify-products.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { productIds, selectedFields: selectedFieldsInput, customData } = body;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return Response.json({ error: "Product IDs are required" }, { status: 400 });
    }

    // Handle selectedFields as either array or JSON string
    let selectedFields: ProductDataField[];
    if (typeof selectedFieldsInput === "string") {
      try {
        selectedFields = JSON.parse(selectedFieldsInput);
      } catch {
        return Response.json({ error: "Invalid selectedFields format" }, { status: 400 });
      }
    } else if (Array.isArray(selectedFieldsInput)) {
      selectedFields = selectedFieldsInput;
    } else {
      return Response.json({ error: "Selected fields are required" }, { status: 400 });
    }

    // Get prompt template customizations from database (base template is always used)
    const templateRecord = await prisma.promptTemplate.findUnique({
      where: { shop },
    });

    // Note: We don't require a template record - base template will be used if none exists
    const userCustomizations = templateRecord?.template || "";

    // Fetch all products
    const products = await Promise.all(
      productIds.map((id: string) => fetchProductById(admin, id))
    );

    const validProducts = products.filter(
      (p): p is NonNullable<typeof p> => p !== null
    );

    if (validProducts.length === 0) {
      return Response.json({ error: "No valid products found" }, { status: 400 });
    }

    // Decrypt API key if stored encrypted
    let apiKey: string | undefined;
    if (templateRecord?.openaiApiKey) {
      try {
        if (isEncrypted(templateRecord.openaiApiKey)) {
          apiKey = decrypt(templateRecord.openaiApiKey);
        } else {
          // Legacy plaintext key — use as-is
          apiKey = templateRecord.openaiApiKey;
        }
      } catch (e) {
        console.error("Failed to decrypt API key:", e);
        return Response.json(
          { error: "Failed to decrypt API key. Check ENCRYPTION_KEY env var." },
          { status: 500 },
        );
      }
    }

    // Generate descriptions with progress tracking
    // Pass user customizations (empty string if none) - base template is always included
    const results = await generateMultipleDescriptions(
      validProducts,
      userCustomizations,
      selectedFields,
      customData || templateRecord?.customData || undefined,
      (completed, total) => {
        // Progress callback - could be used for streaming updates in the future
        console.log(`Progress: ${completed}/${total}`);
      },
      apiKey
    );

    // Convert Map to object for JSON response
    const resultsObject: Record<
      string,
      { description: string; error?: string }
    > = {};
    results.forEach((value, key) => {
      resultsObject[key] = value;
    });

    return Response.json({
      success: true,
      results: resultsObject,
      total: validProducts.length,
      completed: Array.from(results.values()).filter((r) => !r.error).length,
      errors: Array.from(results.values()).filter((r) => r.error).length,

    });
  } catch (error) {
    console.error("Error generating descriptions:", error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to generate descriptions",
      },
      { status: 500 }
    );
  }
};

