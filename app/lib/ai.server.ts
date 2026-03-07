import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { ProductData, ProductDataField } from "./shopify-products.server";
import { extractProductDataForPrompt } from "./shopify-products.server";
import { DEFAULT_PROMPT_TEMPLATE, BANNED_PHRASES } from "./prompts";

// Opening style variations to inject as hints for the model to avoid repetition
const OPENING_STYLE_HINTS = [
  "Start med at beskrive materialets kvalitet eller tekstur.",
  "Åbn med en konkret designdetalje der adskiller produktet.",
  "Start med den kontekst eller anledning produktet passer til.",
  "Begynd med mærkets eller designerens tilgang til dette produkt.",
  "Start med pasformen eller snittet som det centrale element.",
  "Åbn med en sensorisk beskrivelse – hvordan produktet føles eller ser ud.",
  "Start med det mest overraskende eller bemærkelsesværdige ved produktet.",
  "Begynd med farven eller farvekombinationen og hvad den signalerer.",
];

/**
 * Post-processing: Detect and remove concluding/summary sentences from the end of the text.
 * GPT-4o has a strong tendency to wrap up with a final "summary" paragraph no matter how
 * strongly the prompt forbids it. This function strips those programmatically.
 */
function removeConcludingSentences(html: string): string {
  // Patterns that indicate a concluding/summary sentence.
  // These are checked against the LAST <p> block or the last sentence.
  const CONCLUSION_PATTERNS: RegExp[] = [
    // "X er et godt valg..." / "X er et alsidigt valg..." / "X er et oplagt valg..."
    /\ber\s+(et|en)\s+(godt|alsidigt|oplagt|sikkert|naturligt|perfekt|ideelt?|stærkt|solidt|stilsikkert)\s+(valg|bud|investering)/i,
    // "et godt valg til..." / "et godt valg når..."
    /\bet\s+(godt|alsidigt|oplagt|sikkert|naturligt|perfekt)\s+(valg|bud)\b/i,
    // "... er velegnet til..." / "... er ideel til..."
    /\ber\s+(velegnet|ideel|perfekt|oplagt)\s+(til|for|når)/i,
    // "Kombiner dem med..." / "Kombinér dem med..." / "Par dem med..."
    /\b(kombin[eé]r|par|match|style)\s+(dem|den|det|disse|den?)\s+med\b/i,
    // "om du vil..." / "hvad enten du..." / "uanset om du..."
    /\b(hvad\s+enten|uanset\s+om)\s+du\b/i,
    // "når du vil have..." / "når du har brug for..."
    /\bnår\s+du\s+(vil\s+have|har\s+brug|søger|ønsker|leder\s+efter)/i,
    // "disse [product] er..." as a conclusion
    /\bdisse\s+\w+\s+er\s+.{5,}(valg|bud|investering|tilføjelse|garderobe)/i,
    // "den perfekte/ideelle/rette tilføjelse til..."
    /\b(den|et)\s+(perfekte?|ideelle?|rette|oplagte)\s+(tilføjelse|valg|bud|supplement|følgesvend)/i,
    // "du får..." as summary
    /\bdu\s+får\s+.{10,}(kombination|blanding|balance|mix)\s+af\b/i,
    // "en kombination af..." as wrap-up
    /\b(kombination|blanding|balance)\s+af\s+.{5,}(og|samt|med)\b/i,
    // "Samlet set..." / "Alt i alt..." / "Kort sagt..."
    /\b(samlet\s+set|alt\s+i\s+alt|kort\s+sagt|generelt|overordnet\s+set)\b/i,
    // "... i din garderobe" / "... til din garderobe" / "... i garderoben"
    /\b(i|til)\s+(din\s+)?garderobe[n]?\b.*[.!]?\s*$/i,
    // "... i din skosamling" / "... til din samling"
    /\b(i|til)\s+(din\s+)?(skosamling|samling|kollektion)\b/i,
    // "Med sin/sine/sit/sit..." as concluding summary opener
    /^med\s+(sin|sine|sit|sin|dens|dets|deres)\s+/i,
    // "Skoene/Skjorten/Shortsen er..." as concluding assessment
    /^(skoene|skjorten|shortsen|bukserne|jakken|tasken|kjolen|blusen|trøjen|frakken|støvlerne|sneakersene|sandalerne)\s+er\s+.{10,}(valg|bud|tilføjelse)/i,
    // "ved hånden" / "ved din side" / "inden for rækkevidde"
    /\b(ved\s+hånden|ved\s+din\s+side|inden\s+for\s+rækkevidde)\b/i,
    // "sætter pris på..." in concluding context
    /\bder\s+sætter\s+pris\s+på\b.*[.!]\s*$/i,
    // "til dem der..." / "for dem der..."
    /\b(til|for)\s+dem[\s,]+der\s+/i,
  ];

  // Try to remove the last <p>...</p> block if it matches a conclusion pattern
  // Use greedy ([\s\S]*) to consume everything up to the LAST <p>...</p>
  const lastParagraphMatch = html.match(/^([\s\S]*)(<p>([\s\S]*?)<\/p>\s*)$/i);
  
  if (lastParagraphMatch) {
    const beforeLast = lastParagraphMatch[1];
    const lastPContent = lastParagraphMatch[2];
    const lastPText = lastPContent.replace(/<[^>]+>/g, "").trim();
    
    // Check if the last paragraph matches any conclusion pattern
    const isConclusion = CONCLUSION_PATTERNS.some((pattern) => pattern.test(lastPText));
    
    if (isConclusion) {
      console.log(`[AI Quality] Stripped concluding paragraph: "${lastPText.substring(0, 80)}..."`);
      // Return everything before the last paragraph, trimmed
      return beforeLast.trim();
    }
  }

  // Also handle cases where there's no <p> wrapping (raw text or <ul> followed by conclusion)
  // Split by newlines and check the last non-empty line
  const lines = html.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1].replace(/<[^>]+>/g, "").trim();
    
    // Only strip if it's NOT inside a <ul>/<li> (don't strip list items)
    const isInList = /<\/li>\s*$/.test(lines[lines.length - 1].trim()) || 
                     /<\/ul>\s*$/.test(lines[lines.length - 1].trim());
    
    if (!isInList) {
      const isConclusion = CONCLUSION_PATTERNS.some((pattern) => pattern.test(lastLine));
      
      if (isConclusion) {
        console.log(`[AI Quality] Stripped concluding line: "${lastLine.substring(0, 80)}..."`);
        lines.pop();
        return lines.join("\n").trim();
      }
    }
  }

  return html;
}

export async function generateProductDescription(
  product: ProductData,
  promptTemplate: string,
  selectedFields: ProductDataField[],
  customData?: string,
  apiKey?: string,
  variationIndex?: number,
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

  // Build the system prompt (base template without product-specific content)
  // and user prompt (product data + custom instructions) separately.
  // This gives custom instructions much higher priority since they're in the user message.
  
  // Extract the base system instructions (everything before "Produktinformation:")
  const productDataMarker = "Produktinformation:\n{productData}";
  const markerIndex = DEFAULT_PROMPT_TEMPLATE.indexOf(productDataMarker);
  
  let systemPrompt: string;
  const userPromptParts: string[] = [];
  
  if (markerIndex >= 0) {
    // System prompt = everything before "Produktinformation:" 
    systemPrompt = DEFAULT_PROMPT_TEMPLATE.substring(0, markerIndex).trim();
    
    // Get the closing instruction after {productData}
    const afterMarker = DEFAULT_PROMPT_TEMPLATE.substring(markerIndex + productDataMarker.length).trim();
    
    // Build user prompt: custom instructions FIRST (highest priority due to recency), then product data
    if (promptTemplate?.trim()) {
      userPromptParts.push(
        `BUTIKSEJERENS TILPASSEDE INSTRUKTIONER (disse har højeste prioritet – du SKAL følge dem bogstaveligt uden kommentarer, forklaringer eller meta-tekst):\n${promptTemplate}\n\nVigtigt: Følg ovenstående instruktioner direkte i beskrivelsen. Skriv ALDRIG kommentarer som "jeg kan desværre ikke..." eller lignende. Brug stadig korrekt HTML-formatering med <h2>/<h3> overskrifter, <p> afsnit og <ul>/<li> lister som beskrevet i systemprompten.`,
      );
      console.log(`[AI] User customization applied (${promptTemplate.length} chars): "${promptTemplate.substring(0, 100)}"`);
    }
    
    // Add product data
    userPromptParts.push(`Produktinformation:\n${productDataString}`);
    
    // Add closing instruction
    if (afterMarker) {
      userPromptParts.push(afterMarker);
    }
  } else {
    // Fallback: put everything in system prompt
    systemPrompt = DEFAULT_PROMPT_TEMPLATE;
    if (promptTemplate?.trim()) {
      userPromptParts.push(
        `VIGTIGE TILPASSEDE INSTRUKTIONER:\n${promptTemplate}`,
      );
    }
    userPromptParts.push(`Produktinformation:\n${productDataString}`);
  }

  // Add variation hint ONLY if no custom instructions exist
  // (custom instructions may specify their own opening style)
  if (!promptTemplate?.trim()) {
    const styleHint =
      OPENING_STYLE_HINTS[
        (variationIndex ?? Math.floor(Math.random() * OPENING_STYLE_HINTS.length)) %
          OPENING_STYLE_HINTS.length
      ];
    userPromptParts.push(`VARIATIONSHINT (følg dette for denne specifikke tekst): ${styleHint}`);
  }

  // Add banned phrases reminder to the system prompt
  const bannedList = BANNED_PHRASES.slice(0, 15)
    .map((p) => `"${p}"`)
    .join(", ");
  systemPrompt = `${systemPrompt}\n\nPÅMINDELSE: Brug IKKE disse fraser eller lignende: ${bannedList}`;

  const userPrompt = userPromptParts.join("\n\n");

  try {
    // Create OpenAI provider with custom API key if provided, otherwise use default
    const openaiProvider = openaiApiKey
      ? createOpenAI({ apiKey: openaiApiKey })
      : createOpenAI();

    const { text } = await generateText({
      model: openaiProvider("gpt-4o"),
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.55, // Moderate temperature for natural variation while staying on-brand
      maxTokens: 1200,
    });

    // Post-process to remove any forbidden HTML tags that might have been added
    let cleanedText = text;
    
    // Remove any meta-commentary the model might add (e.g., "Jeg kan desværre ikke...")
    // These are lines where the model comments on the instructions instead of following them
    cleanedText = cleanedText
      .replace(/^(?:<p>)?(?:Jeg kan desværre|Jeg kan ikke|Bemærk:|Note:|Desværre)[^<]*(?:<\/p>)?[\s-]*/i, "")
      .replace(/^---\s*/m, "")
      .trim();
    
    // Remove <strong>, <em>, <b>, <i> tags but keep their content
    cleanedText = cleanedText.replace(
      /<\/?(strong|em|b|i|span|div|br)\s*\/?>/gi,
      "",
    );
    // Remove any other forbidden tags
    cleanedText = cleanedText.replace(/<\/?(h1|h4|h5|h6)\s*\/?>/gi, "");

    // POST-PROCESS: Remove concluding/summary sentences from the end
    cleanedText = removeConcludingSentences(cleanedText);

    // Post-process: flag if any banned phrases slipped through (log for monitoring)
    const lowerText = cleanedText.toLowerCase();
    const foundBanned = BANNED_PHRASES.filter((phrase) =>
      lowerText.includes(phrase.toLowerCase()),
    );
    if (foundBanned.length > 0) {
      console.warn(
        `[AI Quality] Banned phrases detected in output for "${product.title}": ${foundBanned.join(", ")}`,
      );
    }

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
        i, // Pass variation index so each product gets a different opening style hint
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
