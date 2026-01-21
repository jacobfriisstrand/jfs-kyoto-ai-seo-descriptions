import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

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

export interface ProductData {
  id: string;
  title?: string;
  description?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  metafields?: Array<{ key: string; value: string }>;
  variants?: Array<{ title: string; price: string }>;
  materials?: string;
  handle?: string;
  featuredImage?: string;
}

export async function fetchProducts(
  admin: AdminApiContext,
  limit: number = 50,
  cursor?: string
): Promise<{
  products: ProductData[];
  hasNextPage: boolean;
  endCursor?: string;
}> {
  const response = await admin.graphql(
    `#graphql
      query getProducts($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              description
              vendor
              productType
              tags
              handle
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
          }
        }
      }`,
    {
      variables: {
        first: limit,
        after: cursor || null,
      },
    }
  );

  const responseJson = await response.json();
  const productsData = responseJson.data?.products;

  const products: ProductData[] = productsData.edges.map((edge: any) => {
    const node = edge.node;
    return {
      id: node.id,
      title: node.title || undefined,
      description: node.description || undefined,
      vendor: node.vendor || undefined,
      productType: node.productType || undefined,
      tags: node.tags || [],
      handle: node.handle || undefined,
      featuredImage: node.featuredImage?.url || undefined,
      metafields: node.metafields?.edges?.map((e: any) => ({
        key: e.node.key,
        value: e.node.value,
      })) || [],
      variants: node.variants?.edges?.map((e: any) => ({
        title: e.node.title,
        price: e.node.price,
      })) || [],
      // Extract materials from metafields if available
      materials: node.metafields?.edges?.find(
        (e: any) => e.node.key?.toLowerCase().includes("material")
      )?.node?.value || undefined,
    };
  });

  return {
    products,
    hasNextPage: productsData.pageInfo.hasNextPage,
    endCursor: productsData.pageInfo.endCursor,
  };
}

export async function fetchProductById(
  admin: AdminApiContext,
  productId: string
): Promise<ProductData | null> {
  const response = await admin.graphql(
    `#graphql
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          description
          vendor
          productType
          tags
          handle
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
    {
      variables: {
        id: productId,
      },
    }
  );

  const responseJson = await response.json();
  const product = responseJson.data?.product;

  if (!product) {
    return null;
  }

  return {
    id: product.id,
    title: product.title || undefined,
    description: product.description || undefined,
    vendor: product.vendor || undefined,
    productType: product.productType || undefined,
    tags: product.tags || [],
    handle: product.handle || undefined,
    featuredImage: product.featuredImage?.url || undefined,
    metafields: product.metafields?.edges?.map((e: any) => ({
      key: e.node.key,
      value: e.node.value,
    })) || [],
    variants: product.variants?.edges?.map((e: any) => ({
      title: e.node.title,
      price: e.node.price,
    })) || [],
    materials: product.metafields?.edges?.find(
      (e: any) => e.node.key?.toLowerCase().includes("material")
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

  if (customData && customData.trim()) {
    parts.push(`Yderligere information: ${customData}`);
  }

  return parts.join("\n\n");
}

