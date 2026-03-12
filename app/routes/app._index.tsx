import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { fetchProducts } from "../lib/shopify-products.server";
import type {
  ProductData,
  ProductDataField,
} from "../lib/shopify-products.server";
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

  // If cursor is provided, this is a "load more" request — return JSON
  if (cursor) {
    try {
      const { products, hasNextPage, endCursor } = await fetchProducts(
        admin,
        50,
        cursor,
      );
      return { products, hasNextPage, endCursor, isLoadMore: true };
    } catch (error) {
      console.error("[app._index] Error loading more products:", error);
      return { products: [], hasNextPage: false, endCursor: undefined, isLoadMore: true };
    }
  }

  try {
    // Initial load: first batch + settings
    const { products, hasNextPage, endCursor } = await fetchProducts(
      admin,
      50,
    );

    // Get prompt template settings
    const template = await prisma.promptTemplate.findUnique({
      where: { shop },
    });

    return {
      products,
      hasNextPage,
      endCursor,
      isLoadMore: false,
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
  } catch (error) {
    console.error("[app._index] Error loading products:", error);
    return {
      products: [],
      hasNextPage: false,
      endCursor: undefined,
      isLoadMore: false,
      selectedFields: ["title", "description", "vendor", "productType"] as ProductDataField[],
      customData: "",
      loadError: "Der opstod en fejl ved indlæsning af produkter. Prøv at genindlæse siden.",
    };
  }
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
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const lastProcessedSave = useRef<unknown>(null);
  const generateFetcher = useFetcher();
  const lastProcessedGeneration = useRef<unknown>(null);
  const loadMoreFetcher = useFetcher<typeof loader>();
  const shopify = useAppBridge();

  // Accumulate all products across pages
  const [allProducts, setAllProducts] = useState<ProductData[]>(
    loaderData.products,
  );
  const [nextCursor, setNextCursor] = useState<string | undefined>(
    loaderData.endCursor,
  );
  const [hasMore, setHasMore] = useState(loaderData.hasNextPage);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const selectedFields = ("selectedFields" in loaderData
    ? loaderData.selectedFields
    : ["title", "description", "vendor", "productType"]) as ProductDataField[];
  const customData = ("customData" in loaderData
    ? loaderData.customData
    : "") as string;

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
  const [savedWithAi, setSavedWithAi] = useState<Set<string>>(new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: editedDescriptions and generatedDescriptions are read at save time
  useEffect(() => {
    if (fetcher.data && fetcher.data !== lastProcessedSave.current) {
      lastProcessedSave.current = fetcher.data;
      if (fetcher.data.success) {
        shopify.toast.show("Beskrivelse gemt");
        // Clear generated descriptions after saving and update product data
        if (fetcher.data.productId) {
          const savedId = fetcher.data.productId as string;
          const savedDesc =
            editedDescriptions.get(savedId) ||
            generatedDescriptions.get(savedId)?.description;
          if (savedDesc) {
            setAllProducts((prev) =>
              prev.map((p) =>
                p.id === savedId ? { ...p, description: savedDesc } : p,
              ),
            );
            if (generatedDescriptions.has(savedId)) {
              setSavedWithAi((prev) => new Set(prev).add(savedId));
            }
          }
          setGeneratedDescriptions((prev) => {
            const next = new Map(prev);
            next.delete(savedId);
            return next;
          });
          setEditedDescriptions((prev) => {
            const next = new Map(prev);
            next.delete(savedId);
            return next;
          });
          setSelectedProductIds((prev) => {
            const next = new Set(prev);
            next.delete(savedId);
            return next;
          });
        } else if ("successful" in fetcher.data && fetcher.data.successful) {
          shopify.toast.show(`${fetcher.data.successful} beskrivelse(r) gemt`);
          // Track AI-generated saves and update all products
          const newAiIds = new Set(savedWithAi);
          setAllProducts((prev) =>
            prev.map((p) => {
              const desc =
                editedDescriptions.get(p.id) ||
                generatedDescriptions.get(p.id)?.description;
              if (desc) {
                if (generatedDescriptions.has(p.id)) {
                  newAiIds.add(p.id);
                }
                return { ...p, description: desc };
              }
              return p;
            }),
          );
          setSavedWithAi(newAiIds);
          setGeneratedDescriptions(new Map());
          setEditedDescriptions(new Map());
          setSelectedProductIds(new Set());
        }
      }
      if (fetcher.data.error) {
        shopify.toast.show(`Fejl: ${fetcher.data.error}`, { isError: true });
      }
    }
  }, [fetcher.data, shopify, editedDescriptions, generatedDescriptions]);

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

    if (generateFetcher.data?.success && generateFetcher.data !== lastProcessedGeneration.current) {
      lastProcessedGeneration.current = generateFetcher.data;
      setIsGenerating(false);
      const results = generateFetcher.data.results as Record<
        string,
        GeneratedDescription
      >;
      setGeneratedDescriptions((prev) => {
        const merged = new Map(prev);
        for (const [id, desc] of Object.entries(results)) {
          merged.set(id, desc);
        }
        return merged;
      });
      // Deselect generated products
      setSelectedProductIds((prev) => {
        const next = new Set(prev);
        for (const id of Object.keys(results)) {
          next.delete(id);
        }
        return next;
      });
      shopify.toast.show(
        `Genererede ${generateFetcher.data.completed} beskrivelse(r)`,
      );
      if (generateFetcher.data.errors > 0) {
        shopify.toast.show(`${generateFetcher.data.errors} fejl opstod`, {
          isError: true,
        });
      }
    }
    if (generateFetcher.data?.error && generateFetcher.data !== lastProcessedGeneration.current) {
      lastProcessedGeneration.current = generateFetcher.data;
      setIsGenerating(false);
      shopify.toast.show(`Fejl: ${generateFetcher.data.error}`, {
        isError: true,
      });
    }
  }, [generateFetcher.data, generateFetcher.state, isGenerating, shopify]);

  // Auto-load all remaining products in background
  useEffect(() => {
    if (loadMoreFetcher.data && loadMoreFetcher.state === "idle") {
      const data = loadMoreFetcher.data;
      if ("products" in data && Array.isArray(data.products)) {
        setAllProducts((prev) => [...prev, ...data.products]);
        setHasMore(data.hasNextPage ?? false);
        setNextCursor(data.endCursor ?? undefined);
        setIsLoadingMore(false);
      }
    }
  }, [loadMoreFetcher.data, loadMoreFetcher.state]);

  useEffect(() => {
    if (hasMore && nextCursor && !isLoadingMore && loadMoreFetcher.state === "idle") {
      setIsLoadingMore(true);
      loadMoreFetcher.load(`/app?index&cursor=${nextCursor}`);
    }
  }, [hasMore, nextCursor, isLoadingMore, loadMoreFetcher]);

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
    if (selectedProductIds.size === allProducts.length) {
      setSelectedProductIds(new Set());
    } else {
      setSelectedProductIds(new Set(allProducts.map((p) => p.id)));
    }
  };

  const handleGenerate = () => {
    if (selectedProductIds.size === 0) {
      shopify.toast.show("Vælg mindst ét produkt", { isError: true });
      return;
    }

    // Filter out products that already have a generated description
    const productIdsToGenerate = Array.from(selectedProductIds).filter(
      (id) => !generatedDescriptions.has(id),
    );

    if (productIdsToGenerate.length === 0) {
      shopify.toast.show("Alle valgte produkter har allerede genererede beskrivelser");
      return;
    }

    setIsGenerating(true);
    setGenerationProgress({ completed: 0, total: productIdsToGenerate.length });

    generateFetcher.submit(
      {
        productIds: productIdsToGenerate,
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

    // Save all generated/edited descriptions, not just selected
    for (const [productId, gen] of generatedDescriptions) {
      const description = editedDescriptions.get(productId) || gen.description;
      if (description) {
        updates.push({ productId, description });
      }
    }

    if (updates.length === 0) {
      shopify.toast.show("Ingen beskrivelser at gemme", { isError: true });
      return;
    }

    const formData = new FormData();
    formData.append("action", "saveBulk");
    formData.append("updates", JSON.stringify(updates));
    fetcher.submit(formData, { method: "POST" });
  };

  const handleSaveSelected = () => {
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
      shopify.toast.show("Ingen valgte beskrivelser at gemme", { isError: true });
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

  const [searchTerm, setSearchTerm] = useState("");
  const searchRef = useRef<HTMLElement | null>(null);
  const [modalProductId, setModalProductId] = useState<string | null>(
    null,
  );
  const [descriptionSort, setDescriptionSort] = useState<
    "none" | "missing-first" | "existing-first"
  >("none");
  const [brandSort, setBrandSort] = useState<"none" | "asc" | "desc">("none");
  const [titleSort, setTitleSort] = useState<"none" | "asc" | "desc">("none");
  const [typeSort, setTypeSort] = useState<"none" | "asc" | "desc">("none");
  const [statusSort, setStatusSort] = useState<"none" | "asc" | "desc">("none");
  const [visibleCount, setVisibleCount] = useState(50);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasGeneratedDescriptions = generatedDescriptions.size > 0;
  const hasSelectedProducts = selectedProductIds.size > 0;

  // Helper: extract numeric product ID for Shopify admin links
  const getAdminProductUrl = (gid: string) => {
    const match = gid.match(/\/Product\/(\d+)/);
    return match ? `shopify://admin/products/${match[1]}` : "#";
  };

  // Sort products: generated always float to top, then by active sort
  const sortedProducts = [...allProducts].sort((a, b) => {
    // Generated descriptions always come first
    const aGenerated = generatedDescriptions.has(a.id);
    const bGenerated = generatedDescriptions.has(b.id);
    if (aGenerated !== bGenerated) return aGenerated ? -1 : 1;

    // Title sort
    if (titleSort !== "none") {
      const aTitle = (a.title || "").toLowerCase();
      const bTitle = (b.title || "").toLowerCase();
      const cmp = aTitle.localeCompare(bTitle, "da");
      if (cmp !== 0) return titleSort === "asc" ? cmp : -cmp;
    }

    // Brand sort
    if (brandSort !== "none") {
      const aVendor = (a.vendor || "").toLowerCase();
      const bVendor = (b.vendor || "").toLowerCase();
      const cmp = aVendor.localeCompare(bVendor, "da");
      if (cmp !== 0) return brandSort === "asc" ? cmp : -cmp;
    }

    // Type sort
    if (typeSort !== "none") {
      const aType = (a.productType || "").toLowerCase();
      const bType = (b.productType || "").toLowerCase();
      const cmp = aType.localeCompare(bType, "da");
      if (cmp !== 0) return typeSort === "asc" ? cmp : -cmp;
    }

    // Status sort
    if (statusSort !== "none") {
      const aStatus = a.status || "";
      const bStatus = b.status || "";
      const cmp = aStatus.localeCompare(bStatus);
      if (cmp !== 0) return statusSort === "asc" ? cmp : -cmp;
    }

    // Description sort
    if (descriptionSort !== "none") {
      const aHasDesc = !!a.description;
      const bHasDesc = !!b.description;
      if (aHasDesc !== bHasDesc) {
        return descriptionSort === "missing-first"
          ? aHasDesc ? 1 : -1
          : aHasDesc ? -1 : 1;
      }
    }

    return 0;
  });

  // Filter by search term
  const filteredProducts = searchTerm
    ? sortedProducts.filter((p) => {
        const term = searchTerm.toLowerCase();
        return (
          (p.title || "").toLowerCase().includes(term) ||
          (p.vendor || "").toLowerCase().includes(term) ||
          (p.productType || "").toLowerCase().includes(term)
        );
      })
    : sortedProducts;

  // Lazy load: only show visibleCount products
  const displayedProducts = filteredProducts.slice(0, visibleCount);

  // Intersection observer for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && visibleCount < filteredProducts.length) {
          setVisibleCount((prev) => Math.min(prev + 50, filteredProducts.length));
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, filteredProducts.length]);

  // Wire up search field event listener (web components need addEventListener)
  useEffect(() => {
    const el = searchRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const value = (e.target as HTMLInputElement)?.value ?? "";
      setSearchTerm(value);
      setVisibleCount(50);
    };
    el.addEventListener("input", handler);
    return () => el.removeEventListener("input", handler);
  }, []);

  // Reset visible count when sorting changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional triggers for sort reset
  useEffect(() => {
    setVisibleCount(50);
  }, [descriptionSort, brandSort, titleSort, typeSort, statusSort]);

  const toggleDescriptionSort = () => {
    setDescriptionSort((prev) => {
      if (prev === "none") return "missing-first";
      if (prev === "missing-first") return "existing-first";
      return "none";
    });
  };

  const toggleBrandSort = () => {
    setBrandSort((prev) => {
      if (prev === "none") return "asc";
      if (prev === "asc") return "desc";
      return "none";
    });
  };

  const toggleTitleSort = () => {
    setTitleSort((prev) => {
      if (prev === "none") return "asc";
      if (prev === "asc") return "desc";
      return "none";
    });
  };

  const toggleTypeSort = () => {
    setTypeSort((prev) => {
      if (prev === "none") return "asc";
      if (prev === "asc") return "desc";
      return "none";
    });
  };

  const toggleStatusSort = () => {
    setStatusSort((prev) => {
      if (prev === "none") return "asc";
      if (prev === "asc") return "desc";
      return "none";
    });
  };

  const showModal = () => {
    const el = document.getElementById("description-modal");
    if (el && "showOverlay" in el) {
      (el as HTMLElement & { showOverlay: () => void }).showOverlay();
    }
  };

  const hideModal = () => {
    const el = document.getElementById("description-modal");
    if (el && "hideOverlay" in el) {
      (el as HTMLElement & { hideOverlay: () => void }).hideOverlay();
    }
  };

  const [modalEditMode, setModalEditMode] = useState(false);

  const openDescriptionModal = (productId: string) => {
    setModalProductId(productId);
    setModalEditMode(false);
    requestAnimationFrame(() => showModal());
  };

  // Modal derived data
  const modalProduct = modalProductId
    ? allProducts.find((p) => p.id === modalProductId) || null
    : null;
  const modalGenerated = modalProductId
    ? generatedDescriptions.get(modalProductId)
    : undefined;
  const modalEdited = modalProductId
    ? editedDescriptions.get(modalProductId)
    : undefined;
  const modalDisplayDescription =
    modalEdited || modalGenerated?.description;

  const loadError = ("loadError" in loaderData ? loaderData.loadError : undefined) as string | undefined;

  return (
    <s-page heading="Produkter" inlineSize="large">
      {loadError && (
        <s-banner variant="critical">{loadError}</s-banner>
      )}
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
      <s-button
        slot="primary-action"
        variant="primary"
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
        <div style={{ marginBottom: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          {[...selectedProductIds].some((id) => generatedDescriptions.has(id) || editedDescriptions.has(id)) && (
            // biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity
            <s-button
              variant="secondary"
              onClick={handleSaveSelected}
              disabled={fetcher.state === "submitting"}
              {...(fetcher.state === "submitting" ? { loading: true } : {})}
            >
              Gem valgte
            </s-button>
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
          <s-button
            slot="secondary-action"
            variant="primary"
            onClick={handleSaveBulk}
            disabled={fetcher.state === "submitting"}
            {...(fetcher.state === "submitting" ? { loading: true } : {})}
          >
            Gem alle
          </s-button>
        </div>
      )}

      <s-section padding="none" accessibilityLabel="Produkter tabel">
        <s-table>
          <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto 220px">
            <s-text-field
              ref={searchRef as React.Ref<never>}
              label="Søg produkter"
              labelAccessibilityVisibility="exclusive"
              icon="search"
              placeholder="Søg efter produkter"
            />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
            <s-button onClick={handleSelectAll} variant="secondary">
              {selectedProductIds.size === allProducts.length
                ? "Fravælg alle"
                : "Vælg alle"}
            </s-button>
            <div style={{ whiteSpace: "nowrap" }}>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text>
                {selectedProductIds.size} af {allProducts.length} valgt
                {searchTerm && ` · ${filteredProducts.length} resultater`}
              </s-text>
              {hasMore && (
                <s-spinner accessibilityLabel="Indlæser produkter" />
              )}
            </s-stack>
            </div>
          </s-grid>

          <s-table-header-row>
            <s-table-header listSlot="primary">
              <button
                type="button"
                onClick={toggleTitleSort}
                style={{
                  cursor: "pointer",
                  userSelect: "none",
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: "inherit",
                }}
              >
                Produkt{" "}
                {titleSort === "asc"
                  ? "↑"
                  : titleSort === "desc"
                    ? "↓"
                    : "↕"}
              </button>
            </s-table-header>
            <s-table-header>
              <button
                type="button"
                onClick={toggleBrandSort}
                style={{
                  cursor: "pointer",
                  userSelect: "none",
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: "inherit",
                }}
              >
                Brand{" "}
                {brandSort === "asc"
                  ? "↑"
                  : brandSort === "desc"
                    ? "↓"
                    : "↕"}
              </button>
            </s-table-header>
            <s-table-header>
              <button
                type="button"
                onClick={toggleTypeSort}
                style={{
                  cursor: "pointer",
                  userSelect: "none",
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: "inherit",
                }}
              >
                Type{" "}
                {typeSort === "asc"
                  ? "↑"
                  : typeSort === "desc"
                    ? "↓"
                    : "↕"}
              </button>
            </s-table-header>
            <s-table-header>
              <button
                type="button"
                onClick={toggleStatusSort}
                style={{
                  cursor: "pointer",
                  userSelect: "none",
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: "inherit",
                }}
              >
                Produkt status{" "}
                {statusSort === "asc"
                  ? "↑"
                  : statusSort === "desc"
                    ? "↓"
                    : "↕"}
              </button>
            </s-table-header>
            <s-table-header listSlot="secondary">
              <button
                type="button"
                onClick={toggleDescriptionSort}
                style={{
                  cursor: "pointer",
                  userSelect: "none",
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: "inherit",
                }}
              >
                Beskrivelse{" "}
                {descriptionSort === "missing-first"
                  ? "↑"
                  : descriptionSort === "existing-first"
                    ? "↓"
                    : "↕"}
              </button>
            </s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>

          <s-table-body>
            {displayedProducts.map((product) => {
              const isSelected = selectedProductIds.has(product.id);
              const generated = generatedDescriptions.get(product.id);
              const edited = editedDescriptions.get(product.id);
              const displayDescription = edited || generated?.description;
              const hasDescription = !!product.description;
              const checkboxId = `product-${product.id}`;

              return (
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
                          href={getAdminProductUrl(product.id)}
                          target="_blank"
                        >
                          {product.title || "Unavngivet produkt"}
                        </s-link>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{product.vendor || "-"}</s-table-cell>
                    <s-table-cell>{product.productType || "-"}</s-table-cell>
                    <s-table-cell>
                      {product.status === "ACTIVE" ? (
                        <s-badge color="base" tone="success">
                          Aktiv
                        </s-badge>
                      ) : product.status === "DRAFT" ? (
                        <s-badge color="base" tone="warning">
                          Kladde
                        </s-badge>
                      ) : (
                        <s-badge color="base">
                          {product.status || "-"}
                        </s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small">
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
                        {savedWithAi.has(product.id) && !displayDescription && (
                          <s-badge color="base">
                            AI-genereret
                          </s-badge>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small">
                        {displayDescription && (
                          // biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity
                          <s-button
                            variant="tertiary"
                            onClick={() => handleSave(product.id)}
                            disabled={fetcher.state === "submitting"}
                          >
                            Gem
                          </s-button>
                        )}
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
                        <s-button
                          variant="tertiary"
                          onClick={() => openDescriptionModal(product.id)}
                          disabled={!displayDescription && !hasDescription}
                        >
                          Vis beskrivelse
                        </s-button>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>

        {/* Infinite scroll sentinel */}
        {visibleCount < filteredProducts.length && (
          <div ref={sentinelRef} style={{ height: "1px" }} />
        )}
        {visibleCount < filteredProducts.length && (
          <s-box padding="base">
            <s-stack direction="inline" alignItems="center" gap="small">
              <s-spinner accessibilityLabel="Indlæser flere produkter" />
              <s-text>
                Viser {displayedProducts.length} af {filteredProducts.length}{" "}
                produkter
              </s-text>
            </s-stack>
          </s-box>
        )}
      </s-section>

      {/* Description modal */}
      <s-modal
        id="description-modal"
        heading={modalProduct?.title || "Beskrivelse"}
        size="large"
        accessibilityLabel="Produktbeskrivelse"
      >
        {modalProduct && (
          modalDisplayDescription ? (
            <s-stack direction="block" gap="base">
              {modalEditMode ? (
                <s-text-area
                  value={modalDisplayDescription}
                  onInput={(e: Event) =>
                    handleEditDescription(
                      modalProduct.id,
                      (e.currentTarget as HTMLTextAreaElement).value,
                    )
                  }
                  label="Beskrivelse"
                  labelAccessibilityVisibility="exclusive"
                  rows={12}
                />
              ) : (
                <div
                // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML description from Shopify admin
                  dangerouslySetInnerHTML={{
                    __html: modalDisplayDescription,
                  }}
                  style={{ maxHeight: "500px", overflow: "auto" }}
                />
              )}
              {modalGenerated?.error && (
                <s-text tone="critical">Fejl: {modalGenerated.error}</s-text>
              )}
            </s-stack>
          ) : modalProduct.description ? (
            <div
            // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML description from Shopify admin
              dangerouslySetInnerHTML={{
                __html: modalProduct.description || "",
              }}
              style={{ maxHeight: "500px", overflow: "auto" }}
            />
          ) : (
            <s-text>Ingen beskrivelse tilgængelig</s-text>
          )
        )}

        {modalDisplayDescription && (
          // biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity
          <s-button
            slot="primary-action"
            variant="primary"
            onClick={() => {
              if (modalProductId) handleSave(modalProductId);
              hideModal();
            }}
            disabled={fetcher.state === "submitting"}
          >
            Gem beskrivelse
          </s-button>
        )}
        {modalDisplayDescription && (
          // biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity
          <s-button
            slot="secondary-actions"
            variant="secondary"
            onClick={() => setModalEditMode(!modalEditMode)}
          >
            {modalEditMode ? "Vis formateret" : "Rediger beskrivelse"}
          </s-button>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
        <s-button
          slot="secondary-actions"
          variant="secondary"
          onClick={() => hideModal()}
        >
          Luk
        </s-button>
      </s-modal>
    </s-page>
  );
}
