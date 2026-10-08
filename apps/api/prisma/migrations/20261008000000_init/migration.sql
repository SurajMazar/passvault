-- Global change sequence for sync (docs/API.md "Sync"). Must exist before the
-- tables whose seq columns default to nextval('pv_change_seq').
CREATE SEQUENCE IF NOT EXISTS "pv_change_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;


-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('pending_mfa', 'pending_enrollment', 'active');

-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('web', 'extension', 'desktop', 'cli');

-- CreateEnum
CREATE TYPE "EmailTokenPurpose" AS ENUM ('verify_email', 'recovery', 'recovery_verified');

-- CreateEnum
CREATE TYPE "MfaStatus" AS ENUM ('pending', 'active');

-- CreateEnum
CREATE TYPE "VaultType" AS ENUM ('personal', 'shared');

-- CreateEnum
CREATE TYPE "SharedVaultKind" AS ENUM ('item', 'project');

-- CreateEnum
CREATE TYPE "VaultRole" AS ENUM ('owner', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('invited', 'accepted', 'declined', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "RecordKind" AS ENUM ('item', 'project');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "authKeyHash" TEXT NOT NULL,
    "kdfAlgorithm" TEXT NOT NULL,
    "kdfVersion" INTEGER NOT NULL,
    "kdfOpsLimit" INTEGER NOT NULL,
    "kdfMemLimitBytes" INTEGER NOT NULL,
    "kdfSalt" TEXT NOT NULL,
    "encryptedUserKey" TEXT NOT NULL,
    "encryptedUserKeyByRecovery" TEXT NOT NULL,
    "recoveryAuthKeyHash" TEXT NOT NULL,
    "publicEncryptionKey" TEXT NOT NULL,
    "encryptedPrivateEncryptionKey" TEXT NOT NULL,
    "publicSigningKey" TEXT NOT NULL,
    "encryptedPrivateSigningKey" TEXT NOT NULL,
    "publicKeySignature" TEXT NOT NULL,
    "encryptedSettings" TEXT,
    "settingsRevision" INTEGER NOT NULL DEFAULT 0,
    "personalVaultId" UUID,
    "securityStamp" TEXT NOT NULL,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "EmailTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaEnrollment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'totp',
    "status" "MfaStatus" NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "lastUsedStep" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "MfaEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "batchId" UUID NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clientDeviceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "clientType" "ClientType" NOT NULL,
    "trustedTokenHash" TEXT,
    "trustedStamp" TEXT,
    "trustedUntil" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "state" "SessionState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "reauthUntil" TIMESTAMP(3),
    "mfaAttempts" INTEGER NOT NULL DEFAULT 0,
    "ipPrefix" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vault" (
    "id" UUID NOT NULL,
    "type" "VaultType" NOT NULL,
    "kind" "SharedVaultKind",
    "ownerId" UUID NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "allowResharing" BOOLEAN NOT NULL DEFAULT false,
    "rotationRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "seq" BIGINT NOT NULL DEFAULT nextval('pv_change_seq'),

    CONSTRAINT "Vault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultMember" (
    "vaultId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "VaultRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "encryptedVaultKey" TEXT NOT NULL,
    "keySignature" TEXT,
    "grantedById" UUID,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "seq" BIGINT NOT NULL DEFAULT nextval('pv_change_seq'),

    CONSTRAINT "VaultMember_pkey" PRIMARY KEY ("vaultId","userId")
);

-- CreateTable
CREATE TABLE "Record" (
    "id" UUID NOT NULL,
    "vaultId" UUID NOT NULL,
    "kind" "RecordKind" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "formatVersion" INTEGER NOT NULL,
    "encryptedKey" TEXT,
    "encryptedPayload" TEXT,
    "size" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "seq" BIGINT NOT NULL DEFAULT nextval('pv_change_seq'),

    CONSTRAINT "Record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordVersion" (
    "id" UUID NOT NULL,
    "recordId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "vaultId" UUID NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,

    CONSTRAINT "RecordVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mutation" (
    "userId" UUID NOT NULL,
    "mutationId" UUID NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mutation_pkey" PRIMARY KEY ("userId","mutationId")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "actorUserId" UUID,
    "subjectUserId" UUID,
    "vaultId" UUID,
    "recordId" UUID,
    "deviceId" UUID,
    "ipPrefix" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "EmailToken_tokenHash_key" ON "EmailToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailToken_userId_purpose_idx" ON "EmailToken"("userId", "purpose");

-- CreateIndex
CREATE INDEX "MfaEnrollment_userId_status_idx" ON "MfaEnrollment"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCode_codeHash_key" ON "RecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_userId_clientDeviceId_key" ON "Device"("userId", "clientDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_deviceId_idx" ON "Session"("deviceId");

-- CreateIndex
CREATE INDEX "Vault_ownerId_idx" ON "Vault"("ownerId");

-- CreateIndex
CREATE INDEX "Vault_seq_idx" ON "Vault"("seq");

-- CreateIndex
CREATE INDEX "VaultMember_userId_status_idx" ON "VaultMember"("userId", "status");

-- CreateIndex
CREATE INDEX "VaultMember_seq_idx" ON "VaultMember"("seq");

-- CreateIndex
CREATE INDEX "Record_vaultId_seq_idx" ON "Record"("vaultId", "seq");

-- CreateIndex
CREATE INDEX "Record_seq_idx" ON "Record"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "RecordVersion_recordId_revision_key" ON "RecordVersion"("recordId", "revision");

-- CreateIndex
CREATE INDEX "Mutation_createdAt_idx" ON "Mutation"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_seq_key" ON "AuditEvent"("seq");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_subjectUserId_createdAt_idx" ON "AuditEvent"("subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_vaultId_createdAt_idx" ON "AuditEvent"("vaultId", "createdAt");

-- AddForeignKey
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vault" ADD CONSTRAINT "Vault_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultMember" ADD CONSTRAINT "VaultMember_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultMember" ADD CONSTRAINT "VaultMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultMember" ADD CONSTRAINT "VaultMember_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordVersion" ADD CONSTRAINT "RecordVersion_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

