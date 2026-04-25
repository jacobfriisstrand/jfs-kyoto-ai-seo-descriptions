import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/** Check if HTML string has actual visible text content */
function hasTextContent(html: string | null | undefined): string | undefined {
  if (!html) return undefined;
  const stripped = html.replace(/<[^>]*>/g, "").trim();
  return stripped.length > 0 ? html : undefined;
}

interface ThrottleStatus {
  maximumAvailable?: number;
  currentlyAvailable?: number;
  restoreRate?: number;
}

interface CostExtension {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: ThrottleStatus;
}

interface GraphQLError {
  message?: string;
  extensions?: { code?: string };
}

interface GraphQLResponseBody<T> {
  data?: T;
  errors?: GraphQLError[];
  extensions?: { cost?: CostExtension };
}

/**
 * Run a GraphQL query against Shopify Admin API with:
 * - Automatic retry on THROTTLED errors using throttleStatus to compute wait time
 * - Proactive backoff when remaining bucket capacity is low
 * - Retry on transient network/5xx errors
 *
 * This is essential when paginating through thousands of products: without
 * throttle handling, a single THROTTLED response causes the loader to fail
 * silently and stop loading remaining pages.
 */
async function shopifyGraphQL<T>(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
  options: { maxRetries?: number; lowWatermark?: number } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 6;
  const lowWatermark = options.lowWatermark ?? 500;
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    try {
      const response = await admin.graphql(query, { variables });
      const body = (await response.json()) as GraphQLResponseBody<T>;

      const cost = body.extensions?.cost;
      const throttle = cost?.throttleStatus;
      const isThrottled = body.errors?.some(
        (e) => e.extensions?.code === "THROTTLED",
      );

      if (isThrottled) {
        const restoreRate = throttle?.restoreRate ?? 50;
        const requested = cost?.requestedQueryCost ?? 100;
        const waitMs = Math.min(
          10_000,
          Math.max(1_000, Math.ceil((requested / restoreRate) * 1_000)),
        );
        attempt++;
        if (attempt > maxRetries) {
          throw new Error(
            `Shopify THROTTLED after ${maxRetries} retries (requested cost ${requested}, restoreRate ${restoreRate})`,
          );
        }
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (body.errors && body.errors.length > 0) {
        // Non-throttle GraphQL errors are not retryable
        throw new Error(
          `Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
        );
      }

      if (!body.data) {
        throw new Error("Shopify GraphQL returned no data");
      }

      // Proactive backoff: if remaining bucket is low, wait so the next
      // call doesn't get throttled. This prevents thrash on long pagination loops.
      if (
        throttle?.currentlyAvailable != null &&
        throttle.restoreRate &&
        throttle.currentlyAvailable < lowWatermark
      ) {
        const deficit = lowWatermark - throttle.currentlyAvailable;
        const waitMs = Math.min(
          5_000,
          Math.ceil((deficit / throttle.restoreRate) * 1_000),
        );
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }

      return body.data;
    } catch (err) {
      lastError = err;
      // Retry transient network/server errors with exponential backoff
      const message = err instanceof Error ? err.message : String(err);
      const isTransient =
        /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|ENOTFOUND|503|502|504/i.test(
          message,
        );
      if (!isTransient || attempt >= maxRetries) {
        throw err;
      }
      attempt++;
      const backoff = Math.min(8_000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("shopifyGraphQL: exhausted retries");
}

export type ProductDataField =
  | "title"
  | "description"
  | "vendor"
  | "productType"
  | "tags"
  | "metafields"
  | "variants"
  | "materials"
  | "handle";

interface MetafieldEdge {
  node: { key: string; value: string };
}

interface VariantEdge {
  node: { title: string; price: string };
}

export interface ProductData {
  id: string;
  title?: string;
  description?: string;
  vendor?: string;
  productType?: string;
  status?: string;
  tags?: string[];
  metafields?: Array<{ key: string; value: string }>;
  variants?: Array<{ title: string; price: string }>;
  materials?: string;
  handle?: string;
  featuredImage?: string;
  totalInventory?: number;
}

export async function fetchProducts(
  admin: AdminApiContext,
  limit: number = 250,
  cursor?: string,
): Promise<{
  products: ProductData[];
  hasNextPage: boolean;
  endCursor?: string;
}> {
  // SLIM list query — only fields the table actually displays.
  // Removed metafields(first:20) and variants(first:10) which together added
  // ~34 cost units PER product node. With first:50 that pushed the query
  // cost to ~1750, far above Shopify's 1000 max query cost limit, causing
  // queries to fail or be heavily throttled. With this slim query, cost is
  // ~252 for first:250 — well within budget.
  // Also dropped `tags` and `handle` (not displayed in the list, only used
  // by AI generation which uses fetchProductById per-product).
  // Heavy fields (metafields, variants) are fetched on
  // demand per-product via fetchProductById when generating a description.
  // descriptionHtml is included so the modal can render existing
  // descriptions with their original formatting (paragraphs, lists, etc.).
  const data = await shopifyGraphQL<{
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{
        node: {
          id: string;
          title?: string;
          descriptionHtml?: string;
          vendor?: string;
          productType?: string;
          status?: string;
          totalInventory?: number;
          featuredImage?: { url?: string };
        };
      }>;
    };
  }>(
    admin,
    `#graphql
      query getProductsList($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              descriptionHtml
              vendor
              productType
              status
              totalInventory
              featuredImage {
                url
              }
            }
          }
        }
      }`,
    {
      first: limit,
      after: cursor || null,
    },
  );

  const productsData = data.products;

  const products: ProductData[] = productsData.edges.map((edge) => {
    const node = edge.node;
    return {
      id: node.id,
      title: node.title || undefined,
      // Use full HTML so the modal can render formatted descriptions.
      // hasTextContent guards against documents that are HTML-only whitespace.
      description: hasTextContent(node.descriptionHtml),
      vendor: node.vendor || undefined,
      productType: node.productType || undefined,
      status: node.status || undefined,
      tags: [],
      featuredImage: node.featuredImage?.url || undefined,
      totalInventory: node.totalInventory ?? undefined,
      metafields: [],
      variants: [],
    };
  });

  return {
    products,
    hasNextPage: productsData.pageInfo.hasNextPage,
    endCursor: productsData.pageInfo.endCursor || undefined,
  };
}

export async function fetchProductById(
  admin: AdminApiContext,
  productId: string
): Promise<ProductData | null> {
  const data = await shopifyGraphQL<{
    product: {
      id: string;
      title?: string;
      descriptionHtml?: string;
      vendor?: string;
      productType?: string;
      status?: string;
      tags?: string[];
      handle?: string;
      totalInventory?: number;
      featuredImage?: { url?: string; altText?: string };
      metafields?: { edges?: MetafieldEdge[] };
      variants?: { edges?: VariantEdge[] };
    } | null;
  }>(
    admin,
    `#graphql
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          descriptionHtml
          vendor
          productType
          status
          tags
          handle
          totalInventory
          featuredImage {
            url
            altText
          }
          metafields(first: 20) {
            edges {
              node {
                key
                value
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                title
                price
              }
            }
          }
        }
      }`,
    { id: productId },
  );

  const product = data.product;

  if (!product) {
    return null;
  }

  return {
    id: product.id,
    title: product.title || undefined,
    description: hasTextContent(product.descriptionHtml),
    vendor: product.vendor || undefined,
    productType: product.productType || undefined,
    status: product.status || undefined,
    tags: product.tags || [],
    handle: product.handle || undefined,
    featuredImage: product.featuredImage?.url || undefined,
    totalInventory: product.totalInventory ?? undefined,
    metafields: product.metafields?.edges?.map((e: MetafieldEdge) => ({
      key: e.node.key,
      value: e.node.value,
    })) || [],
    variants: product.variants?.edges?.map((e: VariantEdge) => ({
      title: e.node.title,
      price: e.node.price,
    })) || [],
    materials: product.metafields?.edges?.find(
      (e: MetafieldEdge) => e.node.key?.toLowerCase().includes("material")
    )?.node?.value || undefined,
  };
}

export function extractProductDataForPrompt(
  product: ProductData,
  selectedFields: ProductDataField[],
  customData?: string
): string {
  const parts: string[] = [];

  if (selectedFields.includes("title") && product.title) {
    parts.push(`Titel: ${product.title}`);
  }

  if (selectedFields.includes("description") && product.description) {
    parts.push(`Eksisterende beskrivelse: ${product.description}`);
  }

  if (selectedFields.includes("vendor") && product.vendor) {
    parts.push(`Mærke: ${product.vendor}`);
  }

  if (selectedFields.includes("productType") && product.productType) {
    parts.push(`Produkttype: ${product.productType}`);
  }

  if (selectedFields.includes("tags") && product.tags && product.tags.length > 0) {
    parts.push(`Tags: ${product.tags.join(", ")}`);
  }

  if (selectedFields.includes("handle") && product.handle) {
    parts.push(`Handle: ${product.handle}`);
  }

  if (selectedFields.includes("materials") && product.materials) {
    parts.push(`Materialer: ${product.materials}`);
  }

  if (selectedFields.includes("metafields") && product.metafields && product.metafields.length > 0) {
    const metafieldInfo = product.metafields
      .map((mf) => `${mf.key}: ${mf.value}`)
      .join("\n");
    parts.push(`Metafelter:\n${metafieldInfo}`);
  }

  if (selectedFields.includes("variants") && product.variants && product.variants.length > 0) {
    const variantInfo = product.variants
      .map((v) => `${v.title}: ${v.price}`)
      .join("\n");
    parts.push(`Varianter:\n${variantInfo}`);
  }

  if (customData?.trim()) {
    parts.push(`Yderligere information: ${customData}`);
  }

  return parts.join("\n\n");
}

/**
 * Fetch ALL products from the store by paginating through all pages server-side.
 * Returns a flat array of all products. Uses throttle-aware pagination so
 * large catalogs (thousands of products) complete reliably without dropping
 * pages on transient throttle/network errors.
 */
export async function fetchAllProducts(
  admin: AdminApiContext,
): Promise<ProductData[]> {
  const allProducts: ProductData[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const { products, hasNextPage, endCursor } = await fetchProducts(
      admin,
      250, // Shopify max for products connection
      cursor,
    );
    allProducts.push(...products);
    hasMore = hasNextPage;
    cursor = endCursor;
  }

  return allProducts;
}

