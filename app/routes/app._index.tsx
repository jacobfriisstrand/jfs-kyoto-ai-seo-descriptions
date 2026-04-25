import { useEffect, useMemo, useRef, useState } from "react";
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
  let admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"];
  let session: Awaited<ReturnType<typeof authenticate.admin>>["session"];
  try {
    ({ admin, session } = await authenticate.admin(request));
  } catch (error) {
    // Re-throw Response objects (redirects from Shopify auth)
    if (error instanceof Response) throw error;
    console.error("[app._index] Authentication error:", error);
    throw error;
  }
  const shop = session.shop;

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || undefined;

  // If cursor is provided, this is a page navigation request.
  // IMPORTANT: on transient error we surface `loadError: true` and KEEP
  // hasNextPage=true with the SAME cursor so the client can retry. Returning
  // hasNextPage:false here was the silent-stop bug that hid thousands of products.
  if (cursor) {
    try {
      const { products, hasNextPage, endCursor } = await fetchProducts(
        admin,
        250,
        cursor,
      );
      return { products, hasNextPage, endCursor, isLoadMore: true };
    } catch (error) {
      console.error("[app._index] Error loading more products:", error);
      return {
        products: [],
        hasNextPage: true, // keep loop alive so client can retry
        endCursor: cursor, // resume from same cursor
        isLoadMore: true,
        pageError: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  try {
    // Initial load: first batch + settings
    const { products, hasNextPage, endCursor } = await fetchProducts(
      admin,
      250,
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
  let admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"];
  try {
    ({ admin } = await authenticate.admin(request));
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[app._index action] Authentication error:", error);
    return { error: "Autentificeringsfejl. Prøv at genindlæse siden." };
  }

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
  const lastProcessedLoadMore = useRef<unknown>(null);
  const shopify = useAppBridge();

  // Accumulate all products across pages for sorting/filtering
  const [allProducts, setAllProducts] = useState<ProductData[]>(
    loaderData.products,
  );
  const [nextCursor, setNextCursor] = useState<string | undefined>(
    loaderData.endCursor,
  );
  const [hasMore, setHasMore] = useState(loaderData.hasNextPage);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 50;
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
      // Go to page 1 and scroll to top so generated descriptions are visible
      setCurrentPage(1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (generateFetcher.data?.error && generateFetcher.data !== lastProcessedGeneration.current) {
      lastProcessedGeneration.current = generateFetcher.data;
      setIsGenerating(false);
      shopify.toast.show(`Fejl: ${generateFetcher.data.error}`, {
        isError: true,
      });
    }
  }, [generateFetcher.data, generateFetcher.state, isGenerating, shopify]);

  // Track consecutive failures to back off and eventually stop the auto-load loop
  const loadRetryCountRef = useRef(0);
  const [loadAllError, setLoadAllError] = useState<string | null>(null);

  // Auto-load all remaining products in background
  useEffect(() => {
    if (loadMoreFetcher.data && loadMoreFetcher.state === "idle" && loadMoreFetcher.data !== lastProcessedLoadMore.current) {
      lastProcessedLoadMore.current = loadMoreFetcher.data;
      const data = loadMoreFetcher.data as {
        products?: ProductData[];
        hasNextPage?: boolean;
        endCursor?: string;
        pageError?: string;
      };

      // Server flagged a page-level error. Back off and retry the same cursor.
      if (data.pageError) {
        loadRetryCountRef.current += 1;
        if (loadRetryCountRef.current >= 5) {
          // Give up after 5 retries on the same cursor to avoid infinite loops.
          setLoadAllError(
            `Kunne ikke indlæse alle produkter: ${data.pageError}. ${allProducts.length} produkter blev indlæst.`,
          );
          setHasMore(false);
          setIsLoadingMore(false);
          return;
        }
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const backoff = 1000 * 2 ** (loadRetryCountRef.current - 1);
        setIsLoadingMore(false);
        const timer = setTimeout(() => {
          // Force re-trigger of the auto-load effect
          setHasMore((h) => h);
        }, backoff);
        return () => clearTimeout(timer);
      }

      if (Array.isArray(data.products)) {
        loadRetryCountRef.current = 0; // reset on success
        const incoming = data.products;
        if (incoming.length > 0) {
          setAllProducts((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const newProducts = incoming.filter(
              (p: ProductData) => !existingIds.has(p.id),
            );
            return newProducts.length === 0 ? prev : [...prev, ...newProducts];
          });
        }
        setHasMore(data.hasNextPage ?? false);
        setNextCursor(data.endCursor ?? undefined);
        setIsLoadingMore(false);
      }
    }
  }, [loadMoreFetcher.data, loadMoreFetcher.state, allProducts.length]);

  useEffect(() => {
    if (hasMore && nextCursor && !isLoadingMore && loadMoreFetcher.state === "idle") {
      setIsLoadingMore(true);
      loadMoreFetcher.load(`/app?index&cursor=${encodeURIComponent(nextCursor)}`);
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
    setSelectedProductIds(new Set(allProducts.map((p) => p.id)));
  };

  const handleDeselectAll = () => {
    setSelectedProductIds(new Set());
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
  const [stockSort, setStockSort] = useState<"none" | "asc" | "desc">("none");
  const hasGeneratedDescriptions = generatedDescriptions.size > 0;
  const hasSelectedProducts = selectedProductIds.size > 0;

  // Helper: extract numeric product ID for Shopify admin links
  const getAdminProductUrl = (gid: string) => {
    const match = gid.match(/\/Product\/(\d+)/);
    return match ? `shopify://admin/products/${match[1]}` : "#";
  };

  // Sort products: generated always float to top, then by active sort.
  // Memoized because allProducts can grow to thousands and resorting on
  // every render (e.g. each checkbox toggle) was a major perf bottleneck.
  const sortedProducts = useMemo(() => {
    return [...allProducts].sort((a, b) => {
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

    // Stock sort
    if (stockSort !== "none") {
      const aStock = a.totalInventory ?? 0;
      const bStock = b.totalInventory ?? 0;
      const cmp = aStock - bStock;
      if (cmp !== 0) return stockSort === "asc" ? cmp : -cmp;
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
  }, [
    allProducts,
    generatedDescriptions,
    titleSort,
    brandSort,
    typeSort,
    statusSort,
    stockSort,
    descriptionSort,
  ]);

  // Filter by search term — memoized for the same reason as sort.
  const filteredProducts = useMemo(() => {
    if (!searchTerm) return sortedProducts;
    const term = searchTerm.toLowerCase();
    return sortedProducts.filter(
      (p) =>
        (p.title || "").toLowerCase().includes(term) ||
        (p.vendor || "").toLowerCase().includes(term) ||
        (p.productType || "").toLowerCase().includes(term),
    );
  }, [sortedProducts, searchTerm]);

  // Paginate: slice from sorted/filtered list
  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / ITEMS_PER_PAGE));
  const displayedProducts = filteredProducts.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE,
  );

  // Wire up search field event listener (web components need addEventListener)
  useEffect(() => {
    const el = searchRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const value = (e.target as HTMLInputElement)?.value ?? "";
      setSearchTerm(value);
      setCurrentPage(1);
    };
    el.addEventListener("input", handler);
    return () => el.removeEventListener("input", handler);
  }, []);

  // Reset to first page when sorting changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional triggers for sort reset
  useEffect(() => {
    setCurrentPage(1);
  }, [descriptionSort, brandSort, titleSort, typeSort, statusSort, stockSort]);

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

  const toggleStockSort = () => {
    setStockSort((prev) => {
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
        <s-banner tone="critical">{loadError}</s-banner>
      )}
      {loadAllError && (
        <s-banner tone="warning">{loadAllError}</s-banner>
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
          <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto auto 220px" alignItems="center">
            <s-text-field
              ref={searchRef as React.Ref<never>}
              label="Søg produkter"
              labelAccessibilityVisibility="exclusive"
              icon="search"
              placeholder="Søg efter produkter"
            />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
            <s-button
              onClick={handleSelectAll}
              variant="secondary"
              disabled={selectedProductIds.size === allProducts.length}
            >
              Vælg alle
            </s-button>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
            <s-button
              onClick={handleDeselectAll}
              variant="secondary"
              disabled={selectedProductIds.size === 0}
            >
              Fravælg alle
            </s-button>
            <div style={{ whiteSpace: "nowrap", display: "flex", alignItems: "center", height: "100%" }}>
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
            <s-table-header>
              <button
                type="button"
                onClick={toggleStockSort}
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
                Lagerantal{" "}
                {stockSort === "asc"
                  ? "↑"
                  : stockSort === "desc"
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
                      {product.totalInventory ?? 0}
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

        {/* Pagination controls */}
        {totalPages > 1 && (
          <s-box padding="base">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px" }}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
              <s-button
                variant="tertiary"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                ← Forrige
              </s-button>
              <s-text>
                Side {currentPage} af {totalPages} · {filteredProducts.length} produkter
              </s-text>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: Shopify web component handles interactivity */}
              <s-button
                variant="tertiary"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Næste →
              </s-button>
            </div>
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
            // List query now fetches `descriptionHtml`, so render as HTML
            // to preserve paragraphs, lists, and other formatting from the
            // Shopify product editor.
            <div
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Shopify-owned content
              dangerouslySetInnerHTML={{ __html: modalProduct.description }}
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
