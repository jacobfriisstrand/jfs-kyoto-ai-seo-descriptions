import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { fetchProducts } from "../lib/shopify-products.server";
import type { ProductDataField } from "../lib/shopify-products.server";
import prisma from "../db.server";

interface GeneratedDescription {
  description: string;
  error?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || undefined;

  const { products, hasNextPage, endCursor } = await fetchProducts(
    admin,
    50,
    cursor,
  );

  // Get prompt template settings
  const template = await prisma.promptTemplate.findUnique({
    where: { shop },
  });

  return {
    products,
    hasNextPage,
    endCursor,
    selectedFields: template?.selectedFields
      ? (JSON.parse(template.selectedFields) as ProductDataField[])
      : ([
          "title",
          "description",
          "vendor",
          "productType",
        ] as ProductDataField[]),
    customData: template?.customData || "",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const actionType = formData.get("action") as string;

  if (actionType === "save") {
    const productId = formData.get("productId") as string;
    const description = formData.get("description") as string;

    if (!productId || !description) {
      return { error: "Product ID and description are required" };
    }

    // Extract GID from Shopify ID format (gid://shopify/Product/123456)
    const gidMatch = productId.match(/\/Product\/(\d+)/);
    if (!gidMatch) {
      return { error: "Invalid product ID format" };
    }

    const response = await admin.graphql(
      `#graphql
        mutation updateProduct($input: ProductInput!) {
          productUpdate(input: $input) {
            product {
              id
              title
              description
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          input: {
            id: productId,
            descriptionHtml: description,
          },
        },
      },
    );

    const responseJson = await response.json();
    const result = responseJson.data?.productUpdate;

    if (result?.userErrors && result.userErrors.length > 0) {
      return {
        error: result.userErrors
          .map((e: { message: string }) => e.message)
          .join(", "),
      };
    }

    return { success: true, productId };
  }

  if (actionType === "saveBulk") {
    const updatesJson = formData.get("updates") as string;
    const updates = JSON.parse(updatesJson) as Array<{
      productId: string;
      description: string;
    }>;

    const results = await Promise.all(
      updates.map(async (update) => {
        try {
          const response = await admin.graphql(
            `#graphql
              mutation updateProduct($input: ProductInput!) {
                productUpdate(input: $input) {
                  product {
                    id
                    title
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`,
            {
              variables: {
                input: {
                  id: update.productId,
                  descriptionHtml: update.description,
                },
              },
            },
          );

          const responseJson = await response.json();
          const result = responseJson.data?.productUpdate;

          if (result?.userErrors && result.userErrors.length > 0) {
            return {
              productId: update.productId,
              success: false,
              error: result.userErrors
                .map((e: { message: string }) => e.message)
                .join(", "),
            };
          }

          return { productId: update.productId, success: true };
        } catch (error) {
          return {
            productId: update.productId,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      }),
    );

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success);

    return {
      success: true,
      successful,
      failed: failed.length > 0 ? failed : undefined,
    };
  }

  return { error: "Invalid action" };
};

export default function ProductsPage() {
  const { products, hasNextPage, endCursor, selectedFields, customData } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const generateFetcher = useFetcher();
  const shopify = useAppBridge();

  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(
    new Set(),
  );
  const [generatedDescriptions, setGeneratedDescriptions] = useState<
    Map<string, GeneratedDescription>
  >(new Map());
  const [editedDescriptions, setEditedDescriptions] = useState<
    Map<string, string>
  >(new Map());
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState({
    completed: 0,
    total: 0,
  });

  useEffect(() => {
    if (fetcher.data) {
      if (fetcher.data.success) {
        shopify.toast.show("Beskrivelse gemt");
        // Clear generated descriptions after saving
        if (fetcher.data.productId) {
          setGeneratedDescriptions((prev) => {
            const next = new Map(prev);
            next.delete(fetcher.data!.productId as string);
            return next;
          });
        } else if ("successful" in fetcher.data && fetcher.data.successful) {
          shopify.toast.show(`${fetcher.data.successful} beskrivelse(r) gemt`);
          setGeneratedDescriptions(new Map());
        }
      }
      if (fetcher.data.error) {
        shopify.toast.show(`Fejl: ${fetcher.data.error}`, { isError: true });
      }
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    // Update loading state based on fetcher state
    if (
      generateFetcher.state === "submitting" ||
      generateFetcher.state === "loading"
    ) {
      if (!isGenerating) {
        setIsGenerating(true);
      }
    } else if (generateFetcher.state === "idle") {
      // Request completed
      if (isGenerating) {
        setIsGenerating(false);
      }
    }

    if (generateFetcher.data?.success) {
      setIsGenerating(false);
      const results = generateFetcher.data.results as Record<
        string,
        GeneratedDescription
      >;
      setGeneratedDescriptions(new Map(Object.entries(results)));
      shopify.toast.show(
        `Genererede ${generateFetcher.data.completed} beskrivelse(r)`,
      );
      if (generateFetcher.data.errors > 0) {
        shopify.toast.show(`${generateFetcher.data.errors} fejl opstod`, {
          isError: true,
        });
      }
    }
    if (generateFetcher.data?.error) {
      setIsGenerating(false);
      shopify.toast.show(`Fejl: ${generateFetcher.data.error}`, {
        isError: true,
      });
    }
  }, [generateFetcher.data, generateFetcher.state, isGenerating, shopify]);

  const handleSelectProduct = (productId: string) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedProductIds.size === products.length) {
      setSelectedProductIds(new Set());
    } else {
      setSelectedProductIds(new Set(products.map((p) => p.id)));
    }
  };

  const handleGenerate = () => {
    if (selectedProductIds.size === 0) {
      shopify.toast.show("Vælg mindst ét produkt", { isError: true });
      return;
    }

    setIsGenerating(true);
    setGenerationProgress({ completed: 0, total: selectedProductIds.size });

    generateFetcher.submit(
      {
        productIds: Array.from(selectedProductIds),
        selectedFields: JSON.stringify(selectedFields),
        customData,
      },
      {
        method: "POST",
        action: "/api/generate-descriptions",
        encType: "application/json",
      },
    );
  };

  const handleSave = (productId: string) => {
    const description =
      editedDescriptions.get(productId) ||
      generatedDescriptions.get(productId)?.description;

    if (!description) {
      shopify.toast.show("Ingen beskrivelse at gemme", { isError: true });
      return;
    }

    const formData = new FormData();
    formData.append("action", "save");
    formData.append("productId", productId);
    formData.append("description", description);
    fetcher.submit(formData, { method: "POST" });
  };

  const handleSaveBulk = () => {
    const updates: Array<{ productId: string; description: string }> = [];

    selectedProductIds.forEach((productId) => {
      const description =
        editedDescriptions.get(productId) ||
        generatedDescriptions.get(productId)?.description;

      if (description) {
        updates.push({ productId, description });
      }
    });

    if (updates.length === 0) {
      shopify.toast.show("Ingen beskrivelser at gemme", { isError: true });
      return;
    }

    const formData = new FormData();
    formData.append("action", "saveBulk");
    formData.append("updates", JSON.stringify(updates));
    fetcher.submit(formData, { method: "POST" });
  };

  const handleEditDescription = (productId: string, description: string) => {
    setEditedDescriptions((prev) => {
      const next = new Map(prev);
      next.set(productId, description);
      return next;
    });
  };

  const [expandedProductId, setExpandedProductId] = useState<string | null>(
    null,
  );
  const hasGeneratedDescriptions = generatedDescriptions.size > 0;
  const hasSelectedProducts = selectedProductIds.size > 0;

  const toggleExpanded = (productId: string) => {
    setExpandedProductId(expandedProductId === productId ? null : productId);
  };

  return (
    <s-page heading="Produkter" inlineSize="large">
      <s-section heading="Tips">
        <s-unordered-list>
          <s-list-item>
            Vælg de produkter, du vil generere beskrivelser for
          </s-list-item>
          <s-list-item>
            Rediger genererede beskrivelser før du gemmer dem
          </s-list-item>
          <s-list-item>
            Beskrivelser gemmes ikke automatisk - du skal godkende dem først
          </s-list-item>
        </s-unordered-list>
      </s-section>
      <s-button
        slot="primary-action"
        onClick={handleGenerate}
        disabled={
          !hasSelectedProducts ||
          isGenerating ||
          generateFetcher.state === "submitting"
        }
        {...(isGenerating || generateFetcher.state === "submitting"
          ? { loading: true }
          : {})}
      >
        {isGenerating || generateFetcher.state === "submitting"
          ? `Genererer... (${generationProgress.completed}/${generationProgress.total})`
          : "Generer beskrivelser"}
      </s-button>

      {hasGeneratedDescriptions && (
        <s-button
          slot="secondary-action"
          onClick={handleSaveBulk}
          disabled={fetcher.state === "submitting"}
          {...(fetcher.state === "submitting" ? { loading: true } : {})}
        >
          Gem alle
        </s-button>
      )}

      <s-section padding="none" accessibilityLabel="Produkter tabel">
        <s-table>
          <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto">
            <s-text-field
              label="Søg produkter"
              labelAccessibilityVisibility="exclusive"
              icon="search"
              placeholder="Søg efter produkter"
            />
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button onClick={handleSelectAll} variant="secondary">
                {selectedProductIds.size === products.length
                  ? "Fravælg alle"
                  : "Vælg alle"}
              </s-button>
              <s-text>
                {selectedProductIds.size} af {products.length} valgt
              </s-text>
            </s-stack>
          </s-grid>

          <s-table-header-row>
            <s-table-header listSlot="primary">Produkt</s-table-header>
            <s-table-header>Mærke</s-table-header>
            <s-table-header>Type</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header listSlot="secondary">Handlinger</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {products.map((product) => {
              const isSelected = selectedProductIds.has(product.id);
              const generated = generatedDescriptions.get(product.id);
              const edited = editedDescriptions.get(product.id);
              const displayDescription = edited || generated?.description;
              const hasDescription = !!product.description;
              const checkboxId = `product-${product.id}`;
              const isExpanded = expandedProductId === product.id;

              return (
                <>
                  <s-table-row key={product.id} clickDelegate={checkboxId}>
                    <s-table-cell>
                      <s-stack
                        direction="inline"
                        gap="small"
                        alignItems="center"
                      >
                        <s-checkbox
                          id={checkboxId}
                          checked={isSelected}
                          onChange={() => handleSelectProduct(product.id)}
                        />
                        {product.featuredImage && (
                          <s-thumbnail
                            size="small"
                            alt={product.title || "Produktbillede"}
                            src={
                              product.featuredImage ||
                              "https://placehold.co/600x400?text=N+A"
                            }
                          />
                        )}
                        <s-link
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            toggleExpanded(product.id);
                          }}
                        >
                          {product.title || "Unavngivet produkt"}
                        </s-link>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{product.vendor || "-"}</s-table-cell>
                    <s-table-cell>{product.productType || "-"}</s-table-cell>
                    <s-table-cell>
                      {displayDescription ? (
                        <s-badge color="base" tone="success">
                          Genereret
                        </s-badge>
                      ) : hasDescription ? (
                        <s-badge color="base" tone="info">
                          Eksisterende
                        </s-badge>
                      ) : (
                        <s-badge color="base" tone="warning">
                          Ingen
                        </s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small">
                        {displayDescription && (
                          <s-button
                            variant="tertiary"
                            onClick={() => handleSave(product.id)}
                            disabled={fetcher.state === "submitting"}
                          >
                            Gem
                          </s-button>
                        )}
                        <s-button
                          variant="tertiary"
                          onClick={() => toggleExpanded(product.id)}
                        >
                          {isExpanded ? "Skjul" : "Vis beskrivelse"}
                        </s-button>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                  {isExpanded && (
                    <s-table-row>
                      <s-table-cell>
                        <s-box padding="base" background="subdued">
                          {displayDescription ? (
                            <s-stack direction="block" gap="base">
                              <s-heading>Genereret beskrivelse</s-heading>
                              <textarea
                                value={displayDescription}
                                onChange={(e) =>
                                  handleEditDescription(
                                    product.id,
                                    e.target.value,
                                  )
                                }
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
                              {generated?.error && (
                                <div style={{ color: "red" }}>
                                  <s-text>Fejl: {generated.error}</s-text>
                                </div>
                              )}
                              <s-button
                                onClick={() => handleSave(product.id)}
                                disabled={fetcher.state === "submitting"}
                              >
                                Gem beskrivelse
                              </s-button>
                            </s-stack>
                          ) : hasDescription ? (
                            <s-stack direction="block" gap="base">
                              <s-heading>Eksisterende beskrivelse</s-heading>
                              <div
                                dangerouslySetInnerHTML={{
                                  __html: product.description || "",
                                }}
                                style={{ maxHeight: "300px", overflow: "auto" }}
                              />
                            </s-stack>
                          ) : (
                            <s-text>Ingen beskrivelse tilgængelig</s-text>
                          )}
                        </s-box>
                      </s-table-cell>
                      <s-table-cell></s-table-cell>
                      <s-table-cell></s-table-cell>
                      <s-table-cell></s-table-cell>
                      <s-table-cell></s-table-cell>
                    </s-table-row>
                  )}
                </>
              );
            })}
          </s-table-body>
        </s-table>

        {hasNextPage && (
          <s-box padding="base">
            <s-link href={`/app/products?cursor=${endCursor}`}>
              Indlæs flere produkter
            </s-link>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
