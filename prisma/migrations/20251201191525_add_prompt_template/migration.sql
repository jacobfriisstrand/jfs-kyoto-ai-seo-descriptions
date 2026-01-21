-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "selectedFields" TEXT NOT NULL,
    "customData" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_shop_key" ON "PromptTemplate"("shop");
