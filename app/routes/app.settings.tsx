import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { DEFAULT_PROMPT_TEMPLATE } from "../lib/prompts";
import type { ProductDataField } from "../lib/shopify-products.server";

const AVAILABLE_FIELDS: Array<{ value: ProductDataField; label: string }> = [
  { value: "title", label: "Titel" },
  { value: "description", label: "Eksisterende beskrivelse" },
  { value: "vendor", label: "Mærke" },
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
    openaiApiKey: template?.openaiApiKey || "",
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

  await prisma.promptTemplate.upsert({
    where: { shop },
    create: {
      shop,
      template,
      selectedFields,
      customData: customData || null,
      openaiApiKey: openaiApiKey || null,
    },
    update: {
      template,
      selectedFields,
      customData: customData || null,
      openaiApiKey: openaiApiKey || null,
    },
  });

  return { success: true };
};

export default function SettingsPage() {
  const { template, selectedFields, customData, openaiApiKey } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [localTemplate, setLocalTemplate] = useState(template);
  const [localSelectedFields, setLocalSelectedFields] =
    useState<ProductDataField[]>(selectedFields);
  const [localCustomData, setLocalCustomData] = useState(customData);
  const [localOpenaiApiKey, setLocalOpenaiApiKey] = useState(openaiApiKey);

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
    formData.append("openaiApiKey", localOpenaiApiKey);
    fetcher.submit(formData, { method: "POST" });
  };

  return (
    <s-page heading="Indstillinger" inlineSize="base">
      <s-button
        slot="primary-action"
        onClick={handleSave}
        {...(fetcher.state === "submitting" ? { loading: true } : {})}
      >
        Gem indstillinger
      </s-button>

      <s-section heading="Base-prompt (kun læsning)">
        <s-paragraph>
          Dette er base-prompten, der altid bruges. Den indeholder alle
          grundlæggende regler for HTML-elementer, dansk grammatik, SEO-krav og
          strukturelle retningslinjer.
        </s-paragraph>
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
          Tilføj dine egne instruktioner og tilpasninger her. Disse bliver
          automatisk tilføjet efter base-prompten ved generering. Du kan tilføje
          stil-retningslinjer, brand-voice, specifikke krav eller andre
          instruktioner.
        </s-paragraph>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <textarea
            value={localTemplate}
            onChange={(e) => setLocalTemplate(e.target.value)}
            placeholder="Tilføj dine egne instruktioner her, f.eks. stil-retningslinjer, brand-voice, eller specifikke krav..."
            style={{
              width: "100%",
              minHeight: "200px",
              fontFamily: "inherit",
              fontSize: "14px",
              padding: "12px",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </s-box>
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
            <label
              key={field.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={localSelectedFields.includes(field.value)}
                onChange={() => handleFieldToggle(field.value)}
                style={{ cursor: "pointer" }}
              />
              <span>{field.label}</span>
            </label>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="OpenAI API-nøgle">
        <s-paragraph>
          Indtast din OpenAI API-nøgle. Hvis ikke angivet, bruges miljøvariablen
          OPENAI_API_KEY. Du kan få en API-nøgle fra{" "}
          <s-link href="https://platform.openai.com/api-keys" target="_blank">
            OpenAI's platform
          </s-link>
          .
        </s-paragraph>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <input
            type="password"
            value={localOpenaiApiKey}
            onChange={(e) => setLocalOpenaiApiKey(e.target.value)}
            placeholder="sk-..."
            style={{
              width: "100%",
              fontFamily: "monospace",
              fontSize: "14px",
              padding: "12px",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </s-box>
        {localOpenaiApiKey && (
          <s-paragraph>
            <s-text>
              API-nøgle er konfigureret (skjult af sikkerhedsmæssige årsager)
            </s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Tilpasset data">
        <s-paragraph>
          Tilføj yderligere information, der skal inkluderes i alle prompts
          (f.eks. brand- eller forhandler-specifikke detaljer):
        </s-paragraph>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <textarea
            value={localCustomData}
            onChange={(e) => setLocalCustomData(e.target.value)}
            placeholder="F.eks. 'Alle produkter er miljøvenlige og produceret i Danmark'"
            style={{
              width: "100%",
              minHeight: "100px",
              fontFamily: "inherit",
              fontSize: "14px",
              padding: "12px",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </s-box>
      </s-section>

      <s-section slot="aside" heading="Tips">
        <s-unordered-list>
          <s-list-item>
            Prompt-skabelonen bestemmer, hvordan AI'en genererer beskrivelser
          </s-list-item>
          <s-list-item>
            Vælg kun de produktdata, der er relevante for din virksomhed
          </s-list-item>
          <s-list-item>
            Tilpasset data inkluderes i alle prompts, uanset hvilke produkter
            der genereres
          </s-list-item>
          <s-list-item>
            API-nøgle gemmes sikkert i databasen og overskriver miljøvariablen
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}
