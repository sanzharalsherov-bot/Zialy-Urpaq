CREATE TABLE "SchoolSettings" (
    "id" TEXT NOT NULL DEFAULT 'school',
    "studentAccessCodeHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SchoolSettings_pkey" PRIMARY KEY ("id")
);
