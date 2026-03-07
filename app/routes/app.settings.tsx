import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { DEFAULT_PROMPT_TEMPLATE } from "../lib/prompts";
import {
  encrypt,
  decrypt,
  isEncrypted,
  maskApiKey,
} from "../lib/encryption.server";
import type { ProductDataField } from "../lib/shopify-products.server";

const AVAILABLE_FIELDS: Array<{ value: ProductDataField; label: string }> = [
  { value: "title", label: "Titel" },
  { value: "description", label: "Eksisterende beskrivelse" },
  { value: "vendor", label: "Brand" },
  { value: "productType", label: "Produkttype" },
  { value: "tags", label: "Tags" },
  { value: "handle", label: "Handle (URL-slug)" },
  { value: "materials", label: "Materialer" },
  { value: "metafields", label: "Metafelter" },
  { value: "variants", label: "Varianter" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const template = await prisma.promptTemplate.findUnique({
    where: { shop },
  });

  // Return masked API key for display - never send actual key to frontend
  let maskedApiKey = "";
  let hasApiKey = false;
  if (template?.openaiApiKey) {
    hasApiKey = true;
    try {
      if (isEncrypted(template.openaiApiKey)) {
        const decrypted = decrypt(template.openaiApiKey);
        maskedApiKey = maskApiKey(decrypted);
      } else {
        // Legacy plaintext key — mask it
        maskedApiKey = maskApiKey(template.openaiApiKey);
      }
    } catch {
      maskedApiKey = "••••••••";
    }
  }

  return {
    template: template?.template || "", // Empty by default - user adds customizations
    selectedFields: template?.selectedFields
      ? (JSON.parse(template.selectedFields) as ProductDataField[])
      : ([
          "title",
          "description",
          "vendor",
          "productType",
        ] as ProductDataField[]),
    customData: template?.customData || "",
    maskedApiKey,
    hasApiKey,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const template = formData.get("template") as string;
  const selectedFields = formData.get("selectedFields") as string;
  const customData = formData.get("customData") as string;
  const openaiApiKey = formData.get("openaiApiKey") as string;

  // Encrypt the API key before storing, or keep existing if unchanged
  let encryptedApiKey: string | null = null;
  if (openaiApiKey && openaiApiKey !== "__unchanged__") {
    try {
      encryptedApiKey = encrypt(openaiApiKey);
    } catch (e) {
      console.error("Failed to encrypt API key:", e);
      return {
        success: false,
        error: "Encryption failed. Check ENCRYPTION_KEY env var.",
      };
    }
  } else if (openaiApiKey === "__unchanged__") {
    // Keep existing value in DB
    const existing = await prisma.promptTemplate.findUnique({
      where: { shop },
      select: { openaiApiKey: true },
    });
    encryptedApiKey = existing?.openaiApiKey || null;
  }

  await prisma.promptTemplate.upsert({
    where: { shop },
    create: {
      shop,
      template,
      selectedFields,
      customData: customData || null,
      openaiApiKey: encryptedApiKey,
    },
    update: {
      template,
      selectedFields,
      customData: customData || null,
      openaiApiKey: encryptedApiKey,
    },
  });

  return { success: true };
};

export default function SettingsPage() {
  const { template, selectedFields, customData, maskedApiKey, hasApiKey } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [localTemplate, setLocalTemplate] = useState(template);
  const [localSelectedFields, setLocalSelectedFields] =
    useState<ProductDataField[]>(selectedFields);
  const [localCustomData, setLocalCustomData] = useState(customData);
  const [localOpenaiApiKey, setLocalOpenaiApiKey] = useState("");
  const [apiKeyChanged, setApiKeyChanged] = useState(false);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Indstillinger gemt");
    }
  }, [fetcher.data, shopify]);

  const handleFieldToggle = (field: ProductDataField) => {
    setLocalSelectedFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    );
  };

  const handleSave = () => {
    const formData = new FormData();
    formData.append("template", localTemplate);
    formData.append("selectedFields", JSON.stringify(localSelectedFields));
    formData.append("customData", localCustomData);
    // Send new key if changed, or sentinel to keep existing
    formData.append(
      "openaiApiKey",
      apiKeyChanged ? localOpenaiApiKey : "__unchanged__",
    );
    fetcher.submit(formData, { method: "POST" });
  };

  return (
    <s-page heading="Indstillinger" inlineSize="large">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: <s-button> is a Shopify web component that is inherently interactive */}
      <s-button
        slot="primary-action"
        onClick={handleSave}
        {...(fetcher.state === "submitting" ? { loading: true } : {})}
      >
        Gem indstillinger
      </s-button>

      <s-section heading="Tips">
        <s-unordered-list>
          <s-list-item>
            Prompt-skabelonen bestemmer, hvordan AI&apos;en genererer
            beskrivelser
          </s-list-item>
          <s-list-item>
            Vælg kun de produktdata, der er relevante for jer
          </s-list-item>
          <s-list-item>
            Tilpasset data inkluderes i alle prompts, uanset hvilke produkter
            der genereres
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Base-prompt (kun læsning)">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <pre
            style={{
              margin: 0,
              fontFamily: "monospace",
              fontSize: "12px",
              whiteSpace: "pre-wrap",
              color: "#666",
            }}
          >
            {DEFAULT_PROMPT_TEMPLATE}
          </pre>
        </s-box>
      </s-section>

      <s-section heading="Tilpasset prompt (tilføjelser)">
        <s-paragraph>
          Tilføj dine egne instruktioner her. De kombineres med base-prompten.
          Eksempler: specifik brand-voice, sæsonbetoning, kampagnefokus, eller
          instruktioner om bestemte produktkategorier.
        </s-paragraph>
        <s-text-area
          label="Tilpasset prompt"
          labelAccessibilityVisibility="exclusive"
          value={localTemplate}
          onInput={(e: Event) => setLocalTemplate((e.currentTarget as HTMLTextAreaElement).value)}
          placeholder="Tilføj dine egne instruktioner her, f.eks. stil-retningslinjer, brand-voice, eller specifikke krav..."
          rows={8}
        />
        <s-paragraph>
          <s-text>
            Dine tilpasninger bliver automatisk kombineret med base-prompten ved
            generering.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Produktdata at inkludere">
        <s-paragraph>
          Vælg hvilke produktdata der skal inkluderes i prompten:
        </s-paragraph>
        <s-stack direction="block" gap="base">
          {AVAILABLE_FIELDS.map((field) => (
            <s-checkbox
              key={field.value}
              label={field.label}
              checked={localSelectedFields.includes(field.value)}
              onChange={() => handleFieldToggle(field.value)}
            />
          ))}
        </s-stack>
      </s-section>

      <s-section heading="OpenAI API-nøgle">
        <s-paragraph>
          Indtast din OpenAI API-nøgle. Du kan få en API-nøgle fra{" "}
          <s-link href="https://platform.openai.com/settings/organization/api-keys" target="_blank">
            OpenAI&apos;s platform
          </s-link>
          .
        </s-paragraph>
        <s-password-field
          label="API-nøgle"
          labelAccessibilityVisibility="exclusive"
          value={localOpenaiApiKey}
          onInput={(e: Event) => {
            setLocalOpenaiApiKey((e.currentTarget as HTMLInputElement).value);
            setApiKeyChanged(true);
          }}
          placeholder={hasApiKey ? maskedApiKey : "sk-..."}
          autocomplete="off"
        />
        {hasApiKey && !apiKeyChanged && (
          <s-paragraph>
            <s-text>
              API-nøgle er gemt (krypteret). Indtast en ny nøgle for at ændre
              den.
            </s-text>
          </s-paragraph>
        )}
        {apiKeyChanged && localOpenaiApiKey && (
          <s-paragraph>
            <s-text>
              Ny API-nøgle vil blive krypteret og gemt når du gemmer
              indstillinger.
            </s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Tilpasset data">
        <s-paragraph>
          Tilføj yderligere information, der skal inkluderes i alle prompts
          (f.eks. brand- eller forhandler-specifikke detaljer):
        </s-paragraph>
        <s-text-area
          label="Tilpasset data"
          labelAccessibilityVisibility="exclusive"
          value={localCustomData}
          onInput={(e: Event) => setLocalCustomData((e.currentTarget as HTMLTextAreaElement).value)}
          placeholder="F.eks. 'Alle produkter er miljøvenlige og produceret i Danmark'"
          rows={4}
        />
      </s-section>
    </s-page>
  );
}
