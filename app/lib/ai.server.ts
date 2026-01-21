import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { ProductData, ProductDataField } from "./shopify-products.server";
import { extractProductDataForPrompt } from "./shopify-products.server";
import { DEFAULT_PROMPT_TEMPLATE } from "./prompts";

export async function generateProductDescription(
  product: ProductData,
  promptTemplate: string,
  selectedFields: ProductDataField[],
  customData?: string,
  apiKey?: string,
): Promise<string> {
  // Use provided API key, or fall back to environment variable
  const openaiApiKey = apiKey || process.env.OPENAI_API_KEY;

  if (!openaiApiKey) {
    throw new Error(
      "OpenAI API key is not set. Please configure it in Settings or set the OPENAI_API_KEY environment variable.",
    );
  }

  // Extract product data based on selected fields
  const productDataString = extractProductDataForPrompt(
    product,
    selectedFields,
    customData,
  );

  // Combine base template with user customizations
  // If the user has customizations, append them to the base template
  let combinedTemplate = DEFAULT_PROMPT_TEMPLATE;
  if (promptTemplate && promptTemplate.trim()) {
    // User has customizations - append them to the base
    combinedTemplate = `${DEFAULT_PROMPT_TEMPLATE}\n\nYderligere instruktioner og tilpasninger:\n${promptTemplate}`;
  }

  // Replace placeholder in combined template
  const fullPrompt = combinedTemplate.replace(
    "{productData}",
    productDataString,
  );

  try {
    // Create OpenAI provider with custom API key if provided, otherwise use default
    const openaiProvider = openaiApiKey
      ? createOpenAI({ apiKey: openaiApiKey })
      : createOpenAI();

    const { text } = await generateText({
      model: openaiProvider("gpt-4o-mini"),
      prompt: fullPrompt,
      temperature: 0.3, // Lower temperature for more consistent, rule-following output
      maxTokens: 1000,
    });

    // Post-process to remove any forbidden HTML tags that might have been added
    let cleanedText = text;
    // Remove <strong>, <em>, <b>, <i> tags but keep their content
    cleanedText = cleanedText.replace(
      /<\/?(strong|em|b|i|span|div|br)\s*\/?>/gi,
      "",
    );
    // Remove any other forbidden tags
    cleanedText = cleanedText.replace(/<\/?(h1|h4|h5|h6)\s*\/?>/gi, "");

    return cleanedText;
  } catch (error) {
    console.error("Error generating description:", error);
    throw new Error(
      `Failed to generate description: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

export async function generateMultipleDescriptions(
  products: ProductData[],
  promptTemplate: string,
  selectedFields: ProductDataField[],
  customData?: string,
  onProgress?: (completed: number, total: number) => void,
  apiKey?: string,
): Promise<Map<string, { description: string; error?: string }>> {
  const results = new Map<string, { description: string; error?: string }>();
  const total = products.length;

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    try {
      const description = await generateProductDescription(
        product,
        promptTemplate,
        selectedFields,
        customData,
        apiKey,
      );
      results.set(product.id, { description });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      results.set(product.id, {
        description: "",
        error: errorMessage,
      });
    }

    // Call progress callback
    if (onProgress) {
      onProgress(i + 1, total);
    }

    // Add a small delay to avoid rate limiting (OpenAI has rate limits)
    if (i < products.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}

// DEFAULT_PROMPT_TEMPLATE is now exported from ./prompts.ts
