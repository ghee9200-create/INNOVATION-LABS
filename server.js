import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import { OAuth2Client } from 'google-auth-library';
import { GoogleGenAI, Type } from '@google/genai';
import mongoose from 'mongoose';

const app = express();
const uploadRefundEvidence = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Evidence must be a JPEG, PNG, or WebP image.'));
    }
    return callback(null, true);
  },
});
const uploadReviewImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Review images must be JPEG, PNG, or WebP files.'));
    }
    return callback(null, true);
  },
});
const port = Number(process.env.PORT || 3001);
const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
const sessionSecret = process.env.SESSION_SECRET;
const configuredRefundEligibilityDays = Number(process.env.REFUND_ELIGIBILITY_DAYS || 4);
const refundEligibilityDays = Number.isFinite(configuredRefundEligibilityDays) && configuredRefundEligibilityDays > 0
  ? configuredRefundEligibilityDays
  : 4;
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || '';
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const planConfig = {
  Starter: { pricePaise: 0, credits: 0, cashbackPaise: 0 },
  Medium: { pricePaise: Number(process.env.PLAN_MEDIUM_PRICE_PAISE || 100000), credits: 0, cashbackPaise: 0 },
  Premium: { pricePaise: Number(process.env.PLAN_PREMIUM_PRICE_PAISE || 200000), credits: 520, cashbackPaise: 20000 },
  Exclusive: { pricePaise: Number(process.env.PLAN_EXCLUSIVE_PRICE_PAISE || 500000), credits: 2020, cashbackPaise: 50000 },
};
const aiCreditCosts = {
  chat: Number(process.env.AI_CHAT_CREDIT_COST || 1),
  search: Number(process.env.AI_SEARCH_CREDIT_COST || 50),
  purchase: Number(process.env.AI_PURCHASE_CREDIT_COST || 100),
};
const aiCreditPricePaise = Number(process.env.AI_CREDIT_PRICE_PAISE || 200);
const aiCreditMaxPurchase = Number(process.env.AI_CREDIT_MAX_PURCHASE || 10000);
const aiCreditPackages = [100, 500, 1000];
let databaseDiagnostic = { state: 'connecting', errorType: null };
const adminVerificationAttempts = new Map();
const giftRecipientAttempts = new Map();
const revokedSessionIds = new Set();
const googleClient = new OAuth2Client(googleClientId);
const User = mongoose.model('User', new mongoose.Schema({
  googleId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, index: true },
  picture: String,
  phoneNumber: { type: String, default: '' },
  recipientAddresses: { type: [mongoose.Schema.Types.Mixed], default: [] },
  promoEligibleAt: Date,
  address: {
    fullName: String,
    phoneNumber: String,
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    pinCode: String,
    country: String,
  },
}, { timestamps: true }));
const CustomOrderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true, lowercase: true },
  requestedItem: { type: String, required: true, trim: true, maxlength: 120 },
  normalizedItem: { type: String, required: true },
  status: { type: String, enum: ['Pending', 'Accepted', 'Rejected', 'Ordered'], default: 'Pending' },
  price: { type: Number, min: 1, default: null },
  acceptedAt: Date,
  orderedAt: Date,
}, { timestamps: true });
CustomOrderSchema.index(
  { userId: 1, normalizedItem: 1 },
  { unique: true, partialFilterExpression: { status: 'Pending' } },
);
const CustomOrder = mongoose.model('CustomOrder', CustomOrderSchema);
const Order = mongoose.model('Order', new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  orderType: { type: String, enum: ['PRODUCT', 'PROMO_CODE', 'DISCOUNT_CODE'], default: 'PRODUCT', index: true },
  purchaseType: { type: String, enum: ['online', 'offline'] },
  recipientType: { type: String, enum: ['myself', 'gift'] },
  userId: { type: String, required: true, index: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true, lowercase: true },
  items: [{
    id: { type: String, required: true },
    customOrderId: String,
    discountOfferId: String,
    name: { type: String, required: true },
    category: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
  }],
  address: { type: mongoose.Schema.Types.Mixed, required: function() { return this.deliveryRequired !== false; } },
  buyerAddress: mongoose.Schema.Types.Mixed,
  recipientAddress: mongoose.Schema.Types.Mixed,
  recipientUserId: String,
  recipientEmail: String,
  deliveryRequired: { type: Boolean, default: true },
  promoCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode' },
  promoCode: String,
  promoCodeAmountPaise: { type: Number, min: 0 },
  rewardPointsEarned: { type: Number, min: 0, default: 0 },
  promoCodeStatus: { type: String, enum: ['PURCHASED', 'PARTIALLY_REDEEMED', 'REDEEMED', 'EXPIRED', 'FULLY_REDEEMED'] },
  promoActivationStatus: { type: String, enum: ['pending', 'active', 'expired', 'fully_redeemed', 'rejected'] },
  promoActivatedAt: Date,
  promoExpiresAt: Date,
  promoMaxUses: { type: Number, min: 1 },
  promoSuccessfulUses: { type: Number, min: 0, default: 0 },
  promoReservationId: String,
  discountCode: String,
  discountAmountPaise: { type: Number, min: 0, default: 0 },
  discountCodePurchaseId: String,
  scratchCardId: String,
  refundAmountPaise: { type: Number, min: 0 },
  refundTransactionReferenceId: String,
  service: { type: String, enum: ['parts', 'coding', 'building', 'full'], default: 'parts' },
  projectDescription: { type: String, default: '' },
  subtotal: { type: Number, required: true, min: 0 },
  codingCharge: { type: Number, default: 0 },
  buildingCharge: { type: Number, default: 0 },
  deliveryCharge: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, default: 'Paid' },
  paymentMethod: { type: String, enum: ['Razorpay', 'Wallet'], default: 'Razorpay' },
  walletBalanceAfterPaise: { type: Number, min: 0 },
  inventoryDeductedAt: Date,
  refundCaseId: { type: String, default: null },
  acceptedAt: Date,
  cancelledAt: Date,
  cancellationId: { type: String, default: null },
  cancellationIdempotencyKey: String,
  cancellationReason: String,
  cancellationType: String,
  cancelledBy: String,
  cancellationRefundAmountPaise: { type: Number, min: 0 },
  cancellationRefundTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
  cancellationBalanceAfterPaise: { type: Number, min: 0 },
  orderStatus: { type: String, default: 'Processing' },
  approvalStatus: { type: String, enum: ['pending', 'accepted', 'rejected', 'not_required'] },
  estimatedDelivery: { type: Date },
  statusHistory: [{ status: String, note: String, createdAt: Date }],
  razorpayId: String,
}, { timestamps: true }));
const Notification = mongoose.model('Notification', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  customOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomOrder' },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
    type: { type: String, default: 'general', index: true },
    data: mongoose.Schema.Types.Mixed,
}, { timestamps: true }));
const RevokedSession = mongoose.model('RevokedSession', new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true }));
const InventoryItem = mongoose.model('InventoryItem', new mongoose.Schema({
  productId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  category: { type: String, trim: true, default: 'Other Components' },
  pricePaise: { type: Number, required: true, min: 0 },
  description: { type: String, default: '' },
  images: { type: [String], default: [] },
  technicalSpecs: { type: mongoose.Schema.Types.Mixed, default: {} },
  stock: { type: Number, required: true, min: 0, default: 0 },
  status: { type: String, enum: ['In Stock', 'Low Stock', 'Out of Stock'], default: 'In Stock' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true }));
const ProductReview = mongoose.model('ProductReview', new mongoose.Schema({
  reviewId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  customerName: { type: String, required: true },
  productId: { type: String, required: true, index: true },
  productName: { type: String, required: true },
  orderId: { type: String, required: true, index: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  description: { type: String, default: '', maxlength: 2000 },
  images: [{
    data: { type: Buffer, required: true },
    contentType: { type: String, required: true },
    originalName: { type: String, required: true },
  }],
  verifiedPurchase: { type: Boolean, required: true, default: true },
  moderationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  moderatedBy: String,
  moderatedAt: Date,
}, { timestamps: true }));
ProductReview.schema.index({ userId: 1, productId: 1 }, { unique: true });
ProductReview.schema.index({ productId: 1, moderationStatus: 1, createdAt: -1 });
const BackInStockSubscription = mongoose.model('BackInStockSubscription', new mongoose.Schema({
  productId: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  email: { type: String, required: true, lowercase: true },
  notifiedAt: Date,
}, { timestamps: true }));
BackInStockSubscription.schema.index({ productId: 1, userId: 1 }, { unique: true });
const AdminSetting = mongoose.model('AdminSetting', new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true }));
const AdminAuditLog = mongoose.model('AdminAuditLog', new mongoose.Schema({
  adminId: { type: String, required: true, index: true },
  action: { type: String, required: true, maxlength: 240 },
  route: { type: String, required: true, maxlength: 240 },
  responseStatus: { type: Number, required: true },
}, { timestamps: true }));
AdminAuditLog.schema.index({ adminId: 1, createdAt: -1 });
const WalletSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  walletId: { type: String, uppercase: true, match: /^@WL[A-Z]{4}\d{4}$/ },
  balancePaise: { type: Number, required: true, min: 0, default: 0 },
  pinHash: { type: String, default: '' },
  failedPinAttempts: { type: Number, default: 0 },
  lockedUntil: Date,
}, { timestamps: true });
WalletSchema.index({ walletId: 1 }, { unique: true, sparse: true });
const Wallet = mongoose.model('Wallet', WalletSchema);
const WalletTransaction = mongoose.model('WalletTransaction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  type: { type: String, enum: ['Recharge', 'Purchase', 'Refund', 'Order Decline Refund', 'Wallet Payment', 'Promo Code', 'Reward Points', 'Adjustment', 'Money Sent', 'Money Received', 'Cancellation Refund'], required: true },
  amountPaise: { type: Number, required: true },
  balanceBeforePaise: { type: Number, required: true },
  balanceAfterPaise: { type: Number, required: true },
  referenceId: { type: String, required: true, unique: true },
  orderId: String,
  refundCaseId: String,
  cancellationId: String,
  transferId: String,
  peerWalletId: String,
  description: { type: String, required: true },
  status: { type: String, enum: ['Pending', 'Successful', 'Failed', 'Completed'], default: 'Successful' },
}, { timestamps: true }));
const RewardAccount = mongoose.model('RewardAccount', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  availablePoints: { type: Number, required: true, default: 0 },
  lifetimePointsEarned: { type: Number, required: true, default: 0, min: 0 },
  lifetimePointsRedeemed: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true }));
const RewardTransaction = mongoose.model('RewardTransaction', new mongoose.Schema({
  transactionId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  userEmail: { type: String, lowercase: true, index: true },
  orderId: { type: String, index: true },
  transactionType: { type: String, enum: ['earned', 'redeemed', 'reversed'], required: true },
  productType: { type: String, default: '' },
  eligibleAmountPaise: { type: Number, required: true, min: 0, default: 0 },
  points: { type: Number, required: true, min: 1 },
  walletAmountPaise: { type: Number, required: true, min: 0, default: 0 },
  status: { type: String, enum: ['earned', 'redeemed', 'reversed'], required: true },
}, { timestamps: true }));
RewardTransaction.schema.index({ userId: 1, createdAt: -1 });
RewardTransaction.schema.index({ orderId: 1, transactionType: 1 });
const RewardRule = mongoose.model('RewardRule', new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'default' },
  minimumEligibleAmountPaise: { type: Number, required: true, min: 0, default: 10000 },
  firstTierMaximumPaise: { type: Number, required: true, min: 1, default: 100000 },
  firstTierPoints: { type: Number, required: true, min: 0, default: 5 },
  higherTierPoints: { type: Number, required: true, min: 0, default: 20 },
  updatedBy: String,
}, { timestamps: true }));
const DiscountCodeRegistry = mongoose.model('DiscountCodeRegistry', new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, match: /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/, unique: true, index: true },
  sourceType: { type: String, enum: ['offer', 'scratch'], required: true },
  sourceId: { type: String, required: true },
}, { timestamps: true }));
const DiscountCodeOffer = mongoose.model('DiscountCodeOffer', new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, match: /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/, unique: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  source: { type: String, enum: ['ADMIN', 'AI_GENERATED', 'SCRATCH_CARD'], default: 'ADMIN', index: true },
  sellingPricePaise: { type: Number, required: true, min: 0 },
  discountType: { type: String, enum: ['fixed', 'percentage'], required: true },
  discountValuePaise: { type: Number, min: 0, default: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  startsAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  maxRedemptions: { type: Number, required: true, min: 1 },
  maxRedemptionsPerCustomer: { type: Number, required: true, min: 1, default: 1 },
  availableQuantity: { type: Number, required: true, min: 0 },
  purchasedCount: { type: Number, default: 0, min: 0 },
  redeemedCount: { type: Number, default: 0, min: 0 },
  minimumPurchasePaise: { type: Number, default: 0, min: 0 },
  eligibilityType: { type: String, enum: ['all', 'categories', 'products'], default: 'all' },
  eligibleCategories: { type: [String], default: [] },
  eligibleProductIds: { type: [String], default: [] },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true }));
DiscountCodeOffer.schema.index({ active: 1, startsAt: 1, expiresAt: 1 });
const PurchasedDiscountCode = mongoose.model('PurchasedDiscountCode', new mongoose.Schema({
  purchaseId: { type: String, required: true, unique: true, index: true },
  offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCodeOffer', default: null },
  code: { type: String, required: true, uppercase: true, match: /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/, index: true },
  userId: { type: String, required: true, index: true },
  purchaserUserId: { type: String, required: true, index: true },
  recipientEmail: { type: String, lowercase: true, trim: true },
  orderId: { type: String, required: true, index: true },
  sellingPricePaise: { type: Number, required: true, min: 0 },
  discountType: { type: String, enum: ['fixed', 'percentage'], required: true },
  discountValuePaise: { type: Number, min: 0, default: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  minimumPurchasePaise: { type: Number, min: 0, default: 0 },
  eligibilityType: { type: String, enum: ['all', 'categories', 'products'], default: 'all' },
  eligibleCategories: { type: [String], default: [] },
  eligibleProductIds: { type: [String], default: [] },
  maxRedemptions: { type: Number, required: true, min: 1, default: 1 },
  maxRedemptionsPerCustomer: { type: Number, required: true, min: 1, default: 1 },
  redemptionCount: { type: Number, required: true, default: 0, min: 0 },
  purchasedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
  fulfillmentStatus: { type: String, enum: ['pending', 'fulfilled', 'rejected'], default: 'pending', index: true },
  isScratchReward: { type: Boolean, default: false },
  scratchCardId: String,
  transferable: { type: Boolean, default: false },
  source: { type: String, enum: ['ADMIN', 'AI_GENERATED', 'SCRATCH_CARD'], default: 'ADMIN' },
}, { timestamps: true }));
PurchasedDiscountCode.schema.index({ userId: 1, code: 1, fulfillmentStatus: 1 });
const DiscountPurchaseIntent = mongoose.model('DiscountPurchaseIntent', new mongoose.Schema({
  razorpayOrderId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  assignedUserId: { type: String, required: true },
  recipientEmail: String,
  offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCodeOffer', required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  idempotencyKey: { type: String, required: true },
  status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending', index: true },
  paymentId: String,
  orderId: String,
}, { timestamps: true }));
DiscountPurchaseIntent.schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
const DiscountRedemption = mongoose.model('DiscountRedemption', new mongoose.Schema({
  redemptionId: { type: String, required: true, unique: true, index: true },
  purchaseId: { type: String, required: true, index: true },
  offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCodeOffer', default: null },
  code: { type: String, required: true, uppercase: true },
  userId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  discountAmountPaise: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['reserved', 'redeemed', 'released', 'refunded'], default: 'redeemed', index: true },
  redeemedAt: Date,
}, { timestamps: true }));
const DiscountCodeUsage = mongoose.model('DiscountCodeUsage', new mongoose.Schema({
  code: { type: String, required: true, uppercase: true },
  userId: { type: String, required: true },
  redemptionCount: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true }));
DiscountCodeUsage.schema.index({ code: 1, userId: 1 }, { unique: true });
const ScratchSettings = mongoose.model('ScratchSettings', new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'default' },
  enabled: { type: Boolean, default: true },
  thresholdPaise: { type: Number, required: true, min: 0, default: 500000 },
  rewardValuesPaise: { type: [Number], default: [5000, 10000, 20000, 50000] },
  discountType: { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
  minimumPurchasePaise: { type: Number, required: true, min: 0, default: 0 },
  eligibilityType: { type: String, enum: ['all', 'categories', 'products'], default: 'all' },
  eligibleCategories: { type: [String], default: [] },
  eligibleProductIds: { type: [String], default: [] },
  expiryDays: { type: Number, required: true, min: 1, default: 30 },
  maxRedemptions: { type: Number, required: true, min: 1, default: 1 },
  transferable: { type: Boolean, default: false },
  updatedBy: String,
}, { timestamps: true }));
const ScratchCard = mongoose.model('ScratchCard', new mongoose.Schema({
  scratchCardId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  eligibleOrderAmountPaise: { type: Number, required: true, min: 0 },
  rewardValuePaise: { type: Number, required: true, min: 1 },
  rewardType: { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
  discountPurchaseId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['issued', 'scratched', 'redeemed', 'reversed'], default: 'issued', index: true },
  createdAt: { type: Date, default: Date.now },
  revealedAt: Date,
}, { timestamps: true }));
ScratchCard.schema.index({ userId: 1, createdAt: -1 });
const Invoice = mongoose.model('Invoice', new mongoose.Schema({
  invoiceId: { type: String, required: true, unique: true, index: true },
  invoiceNumber: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  paymentId: String,
  paymentMethod: { type: String, required: true },
  customerName: String,
  customerEmail: String,
  billingAddress: mongoose.Schema.Types.Mixed,
  items: { type: [mongoose.Schema.Types.Mixed], default: [] },
  subtotalPaise: { type: Number, required: true, min: 0 },
  discountAmountPaise: { type: Number, default: 0, min: 0 },
  discountCode: String,
  serviceChargePaise: { type: Number, default: 0, min: 0 },
  shippingPaise: { type: Number, default: 0, min: 0 },
  taxPaise: { type: Number, default: 0, min: 0 },
  totalPaise: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, enum: ['Paid', 'Refunded', 'Partial Refund'], default: 'Paid' },
  pdfData: { type: Buffer, select: false },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true }));
const CreditNote = mongoose.model('CreditNote', new mongoose.Schema({
  creditNoteNumber: { type: String, required: true, unique: true, index: true },
  invoiceId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, index: true },
  refundCaseId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  amountPaise: { type: Number, required: true, min: 1 },
  reason: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true }));
const Wishlist = mongoose.model('Wishlist', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  productId: { type: String, required: true },
  productType: { type: String, enum: ['product', 'promo', 'discount-code'], required: true },
  addedAt: { type: Date, default: Date.now },
}, { timestamps: true }));
Wishlist.schema.index({ userId: 1, productType: 1, productId: 1 }, { unique: true });
const WalletTransferSchema = new mongoose.Schema({
  transferId: { type: String, required: true, unique: true },
  senderUserId: { type: String, required: true, index: true },
  senderWalletId: { type: String, required: true },
  receiverUserId: { type: String, required: true, index: true },
  receiverWalletId: { type: String, required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  status: { type: String, enum: ['COMPLETED'], required: true },
  idempotencyKey: { type: String, required: true },
  senderBalanceAfterPaise: { type: Number, required: true },
  receiverBalanceAfterPaise: { type: Number, required: true },
  completedAt: { type: Date, required: true },
}, { timestamps: true });
WalletTransferSchema.index({ senderUserId: 1, idempotencyKey: 1 }, { unique: true });
const WalletTransfer = mongoose.model('WalletTransfer', WalletTransferSchema);
const SubscriptionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  plan: { type: String, enum: Object.keys(planConfig), required: true },
  pricePaise: { type: Number, required: true, min: 0 },
  startDate: { type: Date, required: true },
  expiryDate: { type: Date, required: true, index: true },
  autoRenew: { type: Boolean, default: true },
  status: { type: String, enum: ['active', 'expired', 'renewal_failed'], default: 'active', index: true },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'], required: true },
  paymentReference: { type: String, required: true },
  cashbackGranted: { type: Boolean, default: false },
  renewalHistory: [{ date: Date, status: String, paymentReference: String, amountPaise: Number }],
}, { timestamps: true });
SubscriptionSchema.index({ userId: 1, status: 1, expiryDate: -1 });
SubscriptionSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
const Subscription = mongoose.model('Subscription', SubscriptionSchema);
const AICredits = mongoose.model('AICredits', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  balance: { type: Number, required: true, min: 0, default: 0 },
  includedCredits: { type: Number, required: true, min: 0, default: 0 },
  purchasedCredits: { type: Number, required: true, min: 0, default: 0 },
  usedCredits: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true }));
const AICreditTransaction = mongoose.model('AICreditTransaction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  type: { type: String, enum: ['added', 'used'], required: true },
  amount: { type: Number, required: true, min: 1 },
  action: { type: String, required: true },
  reference: { type: String, required: true, unique: true },
  purchaseId: { type: String, index: true },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'] },
  amountPaise: { type: Number, min: 0 },
  previousBalance: { type: Number, min: 0 },
  balanceAfter: { type: Number, required: true, min: 0 },
}, { timestamps: true }));
const CreditPurchase = mongoose.model('CreditPurchase', new mongoose.Schema({
  purchaseId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  idempotencyKey: { type: String, index: true },
  credits: { type: Number, required: true, min: 1 },
  pricePerCreditPaise: { type: Number, required: true, min: 1 },
  totalAmountPaise: { type: Number, required: true, min: 1 },
  currency: { type: String, default: 'INR' },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'], required: true },
  authorizedPlan: { type: String, enum: ['Exclusive'] },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'], default: 'pending', index: true },
  walletTransactionId: String,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  previousBalance: { type: Number, min: 0 },
  newBalance: { type: Number, min: 0 },
  completedAt: Date,
}, { timestamps: true }));
CreditPurchase.schema.index({ userId: 1, createdAt: -1 });
const AIUsage = mongoose.model('AIUsage', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  plan: { type: String, enum: Object.keys(planConfig), required: true },
  action: { type: String, enum: ['chat', 'search', 'purchase'], required: true },
  creditCost: { type: Number, required: true, min: 0 },
}, { timestamps: true }));
const AITrial = mongoose.model('AITrial', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  plan: { type: String, enum: ['Premium', 'Exclusive'], required: true },
  status: { type: String, enum: ['active', 'expired'], required: true, default: 'active', index: true },
  activatedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: true },
  expirationWarningShownAt: Date,
  buildLimit: { type: Number, required: true, min: 1, default: 2 },
  successfulBuilds: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true }));
const AIProjectQuota = mongoose.model('AIProjectQuota', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  quotaKey: { type: String, required: true },
  buildLimit: { type: Number, min: 1, default: null },
  successfulBuilds: { type: Number, required: true, min: 0, default: 0 },
  pendingBuilds: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true }));
AIProjectQuota.schema.index({ userId: 1, quotaKey: 1 }, { unique: true });
const AIProjectBuild = mongoose.model('AIProjectBuild', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  quotaKey: { type: String, required: true },
  plan: { type: String, enum: Object.keys(planConfig), required: true },
  status: { type: String, enum: ['generating', 'succeeded', 'failed'], required: true, index: true },
  result: mongoose.Schema.Types.Mixed,
}, { timestamps: true }));
AIProjectBuild.schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
AIProjectBuild.schema.index({ userId: 1, createdAt: -1 });
const AIComponentCartAction = mongoose.model('AIComponentCartAction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  result: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true }));
AIComponentCartAction.schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
const UserCart = mongoose.model('UserCart', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  items: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true }));
const ProductBrowsingHistorySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  productId: { type: String, required: true },
  productName: { type: String, required: true },
  viewedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true });
ProductBrowsingHistorySchema.index({ userId: 1, productId: 1 }, { unique: true });
ProductBrowsingHistorySchema.index({ userId: 1, viewedAt: -1 });
const ProductBrowsingHistory = mongoose.model('ProductBrowsingHistory', ProductBrowsingHistorySchema);
const PromotionState = mongoose.model('PromotionState', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  shownAt: { type: [Date], default: [] },
  lastShownAt: Date,
}, { timestamps: true }));
const SubscriptionTransaction = mongoose.model('SubscriptionTransaction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  plan: { type: String, enum: Object.keys(planConfig), required: true },
  amountPaise: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'], required: true },
  paymentReference: { type: String, required: true, unique: true },
  cashbackPaise: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['Successful', 'Failed'], default: 'Successful' },
}, { timestamps: true }));
const PlanPayment = mongoose.model('PlanPayment', new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  plan: { type: String, enum: ['Medium', 'Premium', 'Exclusive'], required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending', index: true },
  paymentId: String,
}, { timestamps: true }));
const PromoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, match: /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/ },
  amountPaise: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['unused', 'reserved', 'pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed', 'deactivated'], default: 'unused', index: true },
  createdBy: { type: String, required: true },
  validitySeconds: { type: Number, min: 60, default: 30 * 24 * 60 * 60 },
  maxUses: { type: Number, min: 1, max: 1000, default: 10 },
  successfulUses: { type: Number, min: 0, default: 0 },
  activatedAt: Date,
  expiresAt: Date,
  reservationId: String,
  reservationKey: String,
  reservationOwner: { userId: String },
  reservationExpiresAt: Date,
  purchaseType: { type: String, enum: ['online', 'offline'] },
  recipientType: { type: String, enum: ['myself', 'gift'], default: 'myself' },
  giftRecipientId: String,
  giftRecipientEmail: { type: String, lowercase: true, trim: true },
  giftBuyerId: String,
  giftBuyerName: String,
  giftBuyerEmail: { type: String, lowercase: true, trim: true },
  buyerAddress: mongoose.Schema.Types.Mixed,
  recipientAddress: mongoose.Schema.Types.Mixed,
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'] },
  purchaseIdempotencyKey: String,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  purchasedBy: { userId: String, name: String, email: String },
  purchasedAt: Date,
  orderId: String,
  usedBy: { userId: String, name: String, email: String },
  usedAt: Date,
}, { timestamps: true });
PromoCodeSchema.index({ reservationId: 1 }, { unique: true, sparse: true });
PromoCodeSchema.index({ 'reservationOwner.userId': 1, reservationKey: 1 }, { unique: true, sparse: true });
PromoCodeSchema.index({ purchaseIdempotencyKey: 1 }, { unique: true, sparse: true });
const PromoCode = mongoose.model('PromoCode', PromoCodeSchema);
const expirePromoCodes = async () => {
  const now = new Date();
  const expired = await PromoCode.find({ status: 'purchased', expiresAt: { $lte: now } }).select('_id orderId').lean();
  if (!expired.length) return 0;
  const ids = expired.map((promo) => promo._id);
  await PromoCode.updateMany({ _id: { $in: ids }, status: 'purchased', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
  const orderIds = expired.map((promo) => promo.orderId).filter(Boolean);
  if (orderIds.length) await Order.updateMany(
    { orderId: { $in: orderIds }, orderType: 'PROMO_CODE' },
    { $set: { promoActivationStatus: 'expired', promoCodeStatus: 'EXPIRED' } },
  );
  return expired.length;
};
const promoExpirySweep = setInterval(() => {
  if (mongoose.connection.readyState === 1) {
    expirePromoCodes().catch((error) => console.error('Promo expiry sweep failed:', error.name));
  }
}, 30_000);
promoExpirySweep.unref();
const refundStatuses = [
  'REFUND_PLACED', 'ORDER_CHECK_PENDING', 'ORDER_CHECKING', 'RETURN_REQUIRED',
  'PACKAGE_ARRIVED', 'PART_CHECKING', 'ORDER_ACCEPTED', 'ORDER_DECLINED',
  'REFUND_PROCESSING', 'REFUND_INITIATED', 'REFUND_CREDITED', 'REFUND_COMPLETED', 'REFUND_REJECTED',
];
const RefundSchema = new mongoose.Schema({
  refundCaseId: { type: String, required: true, unique: true },
  orderId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true },
  originalOrderAmountPaise: { type: Number, min: 0 },
  calculatedRefundAmountPaise: { type: Number, min: 0 },
  approvedRefundAmountPaise: { type: Number, min: 0 },
  refundAmountPaise: { type: Number, required: true, min: 1 },
  itemsSnapshot: [{ id: String, name: String, category: String, price: Number, quantity: Number }],
  orderSnapshot: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: refundStatuses, default: 'REFUND_PLACED' },
  reason: { type: String, default: '' },
  reasonCategory: { type: String, default: 'Other' },
  evidence: {
    fileName: String,
    contentType: String,
    size: Number,
    data: { type: Buffer, select: false },
  },
  adminReason: { type: String, default: '' },
  walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
  walletTransactionReferenceId: String,
  statusHistory: [{ status: String, changedBy: String, note: String, createdAt: Date }],
  adminAudit: [{ adminId: String, action: String, timestamp: Date, oldStatus: String, newStatus: String, amountPaise: Number, reason: String }],
}, { timestamps: true });
const Refund = mongoose.model('Refund', RefundSchema);

const frontendBuildPath = fileURLToPath(new URL('.', import.meta.url));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.get(/^\/[\w-]+-[\w-]{8}\.(?:js|css)$/, (req, res, next) => {
  return res.sendFile(path.join(frontendBuildPath, path.basename(req.path)), (error) => {
    if (error) next();
  });
});

const requireSession = (req, res, next) => {
  (async () => {
    let session;
    try {
      session = jwt.verify(req.cookies.innovation_session || '', sessionSecret);
    } catch {
      return res.sendStatus(401);
    }
    req.session = session;
    if (!session.jti) return next();
    if (revokedSessionIds.has(session.jti)) return res.sendStatus(401);
    if (mongoose.connection.readyState === 1) {
      try {
        if (await RevokedSession.exists({ sessionId: session.jti })) return res.sendStatus(401);
      } catch (error) {
        console.error('Could not verify session revocation:', error.name);
        return res.status(503).json({ message: 'Your session could not be verified because the database is unavailable.' });
      }
    }
    return next();
  })();
};

const walletUnlockCookieName = 'innovation_wallet_unlock';
const walletUnlockCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 15 * 60 * 1000,
  path: '/api',
};

const issueWalletUnlock = (res, session) => {
  const token = jwt.sign({ sub: session.sub, sessionJti: session.jti, scope: 'wallet' }, sessionSecret, { expiresIn: '15m' });
  res.cookie(walletUnlockCookieName, token, walletUnlockCookieOptions);
};

const hasWalletUnlock = (req) => {
  try {
    const authorization = jwt.verify(req.cookies[walletUnlockCookieName] || '', sessionSecret);
    return authorization.scope === 'wallet'
      && authorization.sub === req.session.sub
      && authorization.sessionJti === req.session.jti;
  } catch {
    return false;
  }
};

const requireWalletUnlock = (req, res, next) => {
  if (!hasWalletUnlock(req)) {
    return res.status(423).json({ walletLocked: true, message: 'Verify your Wallet PIN to continue.' });
  }
  issueWalletUnlock(res, req.session);
  return next();
};

const requireDatabase = (_req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    const messages = {
      authentication: 'Database authentication failed. Check the server MongoDB credentials.',
      dns: 'The database hostname could not be resolved.',
      timeout: 'The database connection timed out.',
      network: 'The database network connection was refused.',
      configuration: 'The server database configuration is missing or invalid.',
    };
    return res.status(503).json({
      message: messages[databaseDiagnostic.errorType] || 'Unable to connect to the database right now.',
      errorType: databaseDiagnostic.errorType || 'unavailable',
    });
  }
  return next();
};

const classifyDatabaseError = (error) => {
  if (error?.code === 117) return 'operation-conflict';
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('auth') || message.includes('bad auth')) return 'authentication';
  if (message.includes('enotfound') || message.includes('querysrv') || message.includes('dns')) return 'dns';
  if (message.includes('timeout') || message.includes('server selection')) return 'timeout';
  if (message.includes('econnrefused') || message.includes('network') || message.includes('ip')) return 'network';
  if (message.includes('uri') || message.includes('connection string')) return 'configuration';
  return 'unknown';
};

const requireAdmin = (req, res, next) => {
  const verifiedAdmin = req.session.admin === true && adminEmail && String(req.session.email || '').trim().toLowerCase() === adminEmail;
  if (!verifiedAdmin) {
    return res.status(403).json({ message: 'Admin access is required.' });
  }
  return next();
};

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/admin/')
    || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300 || req.session?.admin !== true || !req.session.sub) return;
    AdminAuditLog.create({
      adminId: req.session.sub,
      action: `${req.method} ${req.path}`.slice(0, 240),
      route: req.path.slice(0, 240),
      responseStatus: res.statusCode,
    }).catch((error) => {
      console.error('Could not persist admin audit event:', error.name);
    });
  });
  return next();
});

const isAdminEmail = (email) => Boolean(adminEmail) && String(email || '').trim().toLowerCase() === adminEmail;

const createSessionCookie = (res, payload) => {
  const session = jwt.sign({ ...payload, jti: crypto.randomUUID() }, sessionSecret, { expiresIn: '7d' });
  res.cookie('innovation_session', session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

const toPaise = (amount) => {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
};

const money = (paise) => Math.round(paise) / 100;

const hashPin = (pin) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

const verifyPin = (pin, storedHash) => {
  const [salt, expected] = String(storedHash || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(pin, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
};

const validatePin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);
const normalizeWalletId = (value) => String(value || '').trim().toUpperCase();
const validateWalletId = (value) => /^@WL[A-Z]{4}\d{4}$/.test(value);
const safeRecipientName = (value) => {
  const parts = String(value || 'Innovation Labs user').trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] || 'Innovation Labs user';
};

const findDeliveredAt = (order) => {
  const delivery = (order.statusHistory || [])
    .filter((entry) => ['Delivered', 'Completed'].includes(entry.status) && entry.createdAt)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
  return delivery ? new Date(delivery.createdAt) : null;
};

const refundEligibilityFor = (order, existingRefund = null, now = new Date()) => {
  if (existingRefund) return { eligible: false, reason: 'A refund case already exists for this order.', refund: existingRefund };
  if (order.orderType === 'PROMO_CODE') return { eligible: false, reason: 'Digital Promo Code purchases are non-refundable.', deliveredAt: null };
  if (order.paymentMethod !== 'Wallet') return { eligible: false, reason: 'Wallet refunds are available only for orders paid using Wallet.' };
  if (order.orderStatus === 'Cancelled' || order.cancellationId) return { eligible: false, reason: 'This order has been cancelled.' };
  if (!['Delivered', 'Completed'].includes(order.orderStatus)) {
    return { eligible: false, reason: 'The order must be delivered before requesting a refund.', deliveredAt: null };
  }
  const deliveredAt = findDeliveredAt(order);
  if (!deliveredAt) return { eligible: false, reason: 'The delivery date is not available yet.', deliveredAt: null };
  const eligibleAt = new Date(deliveredAt.getTime() + refundEligibilityDays * 24 * 60 * 60 * 1000);
  if (now < eligibleAt) {
    return { eligible: false, reason: `Refund requests open ${refundEligibilityDays} days after delivery.`, deliveredAt, eligibleAt };
  }
  return { eligible: true, reason: '', deliveredAt, eligibleAt };
};

const cancellationEligibilityFor = (order, hasUnusedDiscountCodePurchases = false) => {
  if (order.orderType === 'PROMO_CODE') return { eligible: false, reason: 'Digital Promo Code purchases cannot be cancelled or refunded.' };
  if (order.orderType === 'DISCOUNT_CODE' && !hasUnusedDiscountCodePurchases) return { eligible: false, reason: 'This Discount Promo Code is not available for cancellation.' };
  if (order.paymentMethod !== 'Wallet') return { eligible: false, reason: 'Only Wallet-paid orders can use wallet cancellation.' };
  if (order.paymentStatus !== 'Paid') return { eligible: false, reason: 'Only paid orders can be cancelled.' };
  const cancellableStatus = order.orderType === 'DISCOUNT_CODE'
    ? ['Processing', 'Confirmed'].includes(order.orderStatus)
    : order.orderStatus === 'Processing';
  if (!cancellableStatus || order.acceptedAt || (order.statusHistory || []).some((entry) => entry.status === 'Accepted')) {
    return { eligible: false, reason: 'Orders can only be cancelled before admin acceptance.' };
  }
  if (order.cancelledAt || order.cancellationId || order.orderStatus === 'Cancelled') return { eligible: false, reason: 'This order has already been cancelled.' };
  if (order.refundCaseId) return { eligible: false, reason: 'This order already has a refund case.' };
  return { eligible: true, reason: '' };
};

const orderDiscountCodePurchasesAreUnused = (order, purchases) => {
  if (order.orderType !== 'DISCOUNT_CODE') return false;
  const expectedCount = (order.items || []).reduce((sum, item) =>
    sum + (item.discountOfferId ? Number(item.quantity || 0) : 0), 0);
  return expectedCount > 0
    && purchases.length === expectedCount
    && purchases.every((purchase) =>
      purchase.fulfillmentStatus === 'fulfilled' && purchase.redemptionCount === 0 && purchase.offerId);
};

const refundEvidenceUpload = (req, res, next) => uploadRefundEvidence.single('evidence')(req, res, (error) => {
  if (!error) return next();
  return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: error.message || 'Evidence upload failed.' });
});

const identifyRefundImage = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const walletView = (wallet, transactions = []) => ({
  balance: money(wallet.balancePaise),
  hasPin: Boolean(wallet.pinHash),
  walletId: wallet.walletId || null,
  transactions: transactions.map((transaction) => ({
    id: transaction._id,
    type: transaction.type,
    amount: money(transaction.amountPaise),
    balanceAfter: money(transaction.balanceAfterPaise),
    referenceId: transaction.referenceId,
    orderId: transaction.orderId || null,
    refundCaseId: transaction.refundCaseId || null,
    transferId: transaction.transferId || null,
    peerWalletId: transaction.peerWalletId || null,
    description: transaction.description,
    status: transaction.status,
    createdAt: transaction.createdAt,
  })),
});

const setRefundStatus = (refund, status, changedBy, note = '', action = 'status_changed') => {
  const oldStatus = refund.status;
  const timestamp = new Date();
  refund.status = status;
  refund.statusHistory.push({ status, changedBy, note, createdAt: timestamp });
  refund.adminAudit.push({
    adminId: changedBy,
    action,
    timestamp,
    oldStatus,
    newStatus: status,
    amountPaise: refund.approvedRefundAmountPaise ?? refund.refundAmountPaise,
    reason: note,
  });
};

const withMongoTransaction = async (callback) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await callback(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const modelInitialization = new Map();
const ensureMongoCollections = async (models) => {
  for (const model of models) {
    let initialization = modelInitialization.get(model);
    if (!initialization) {
      initialization = model.init();
      modelInitialization.set(model, initialization);
      initialization.catch(() => modelInitialization.delete(model));
    }
    await initialization;
  }
};

const defaultRewardRules = {
  minimumEligibleAmountPaise: 10000,
  firstTierMaximumPaise: 100000,
  firstTierPoints: 5,
  higherTierPoints: 20,
};

const rewardRulesFor = async (session) => await RewardRule.findOne({ key: 'default' }).session(session).lean() || defaultRewardRules;

const pointsForEligibleAmount = (eligibleAmountPaise, rules) => {
  if (eligibleAmountPaise <= rules.minimumEligibleAmountPaise) return 0;
  return eligibleAmountPaise <= rules.firstTierMaximumPaise ? rules.firstTierPoints : rules.higherTierPoints;
};

const eligibleOrderAmountPaise = (order) => {
  if (order.orderType === 'PROMO_CODE') return Math.max(0, Number(order.promoCodeAmountPaise || 0));
  if (order.orderType !== 'PRODUCT') return 0;
  const eligible = (order.items || []).reduce((total, item) => {
    if (/plan|membership|subscription|service|delivery|ai credit/i.test(`${item.category || ''} ${item.name || ''}`)) return total;
    const itemAmount = toPaise(item.price) * Number(item.quantity || 0);
    return Number.isSafeInteger(itemAmount) && itemAmount > 0 ? total + itemAmount : total;
  }, 0);
  return Math.max(0, eligible - Number(order.discountAmountPaise || 0));
};

const awardRewardPointsForOrder = async (session, order) => {
  if (!order || order.paymentStatus !== 'Paid' || ['Cancelled', 'Declined', 'Rejected', 'Failed'].includes(order.orderStatus)) return null;
  const eligibleAmountPaise = eligibleOrderAmountPaise(order);
  const rules = await rewardRulesFor(session);
  const points = pointsForEligibleAmount(eligibleAmountPaise, rules);
  if (!Number.isSafeInteger(points) || points <= 0 || !order.orderId || !order.userId) return null;
  const transactionId = `earn:${order.orderId}`;
  const existingTransaction = await RewardTransaction.findOne({ transactionId }).session(session).lean();
  if (existingTransaction) {
    order.rewardPointsEarned = existingTransaction.points;
    await Order.updateOne({ orderId: order.orderId, userId: order.userId }, { $set: { rewardPointsEarned: existingTransaction.points } }, { session });
    return existingTransaction.points;
  }
  await RewardAccount.findOneAndUpdate(
    { userId: order.userId },
    { $setOnInsert: { userId: order.userId }, $inc: { availablePoints: points, lifetimePointsEarned: points } },
    { upsert: true, new: true, setDefaultsOnInsert: true, session },
  );
  const productType = order.orderType === 'PROMO_CODE' ? 'Promo Code' : 'Physical Parts';
  await RewardTransaction.create([{
    transactionId,
    userId: order.userId,
    userEmail: order.userEmail,
    orderId: order.orderId,
    transactionType: 'earned',
    productType,
    eligibleAmountPaise,
    points,
    walletAmountPaise: 0,
    status: 'earned',
  }], { session });
  order.rewardPointsEarned = points;
  await Order.updateOne({ orderId: order.orderId, userId: order.userId }, { $set: { rewardPointsEarned: points } }, { session });
  return points;
};

const reverseRewardPointsForOrder = async (session, order, { referenceId, refundAmountPaise }) => {
  if (!order?.orderId || !order.userId || !referenceId) return 0;
  const earned = await RewardTransaction.findOne({ userId: order.userId, orderId: order.orderId, transactionType: 'earned' }).session(session).lean();
  if (!earned) return 0;
  const transactionId = `reverse:${referenceId}`;
  if (await RewardTransaction.exists({ transactionId }).session(session)) return 0;
  const eligibleRefundPaise = Math.min(earned.eligibleAmountPaise, Math.max(0, Number(refundAmountPaise) || 0));
  if (!eligibleRefundPaise || !earned.eligibleAmountPaise) return 0;
  const points = eligibleRefundPaise >= earned.eligibleAmountPaise
    ? earned.points
    : Math.floor(earned.points * eligibleRefundPaise / earned.eligibleAmountPaise);
  if (!points) return 0;
  await RewardAccount.updateOne(
    { userId: order.userId },
    { $inc: { availablePoints: -points } },
    { session },
  );
  await RewardTransaction.create([{
    transactionId,
    userId: order.userId,
    userEmail: order.userEmail,
    orderId: order.orderId,
    transactionType: 'reversed',
    productType: earned.productType,
    eligibleAmountPaise: eligibleRefundPaise,
    points,
    walletAmountPaise: 0,
    status: 'reversed',
  }], { session });
  return points;
};

const invoiceCurrency = (paise) => `INR ${money(paise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const renderInvoicePdf = (invoice) => new Promise((resolve, reject) => {
  const document = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const chunks = [];
  document.on('data', (chunk) => chunks.push(chunk));
  document.on('error', reject);
  document.on('end', () => resolve(Buffer.concat(chunks)));
  const right = (text, y, options = {}) => document.font('Helvetica').fontSize(9).fillColor('#47616b').text(text, 320, y, { width: 225, align: 'right', ...options });
  document.rect(0, 0, 612, 128).fill('#071b24');
  document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text('INNOVATION LABS', 48, 43);
  document.fillColor('#73e6f4').font('Helvetica').fontSize(9).text('TECHNOLOGY FOR IDEAS IN MOTION', 50, 76);
  if (process.env.COMPANY_ADDRESS) document.fillColor('#bfd2d8').fontSize(8).text(process.env.COMPANY_ADDRESS, 50, 96, { width: 330 });
  if (process.env.SUPPORT_EMAIL) document.fillColor('#bfd2d8').fontSize(8).text(process.env.SUPPORT_EMAIL, 50, 109);
  document.fillColor('#0b2029').font('Helvetica-Bold').fontSize(20).text('INVOICE', 48, 152);
  right(`Invoice ${invoice.invoiceNumber}`, 155);
  right(`Date ${new Date(invoice.createdAt).toLocaleDateString('en-IN')}`, 171);
  right(`Order ${invoice.orderId}`, 187);
  right(`Payment method ${invoice.paymentMethod}`, 203);
  right(`Transaction ${invoice.paymentId || '—'}`, 219, { ellipsis: true });
  document.moveTo(48, 232).lineTo(564, 232).strokeColor('#cbd8dc').stroke();
  document.fillColor('#0b2029').font('Helvetica-Bold').fontSize(10).text('BILLED TO', 48, 250);
  document.font('Helvetica').fontSize(9).fillColor('#304b56').text(invoice.customerName || 'Customer', 48, 268);
  document.text(invoice.customerEmail || '', 48, 282);
  const address = invoice.billingAddress || {};
  const addressText = [address.fullName, address.phoneNumber, address.addressLine1, address.addressLine2, address.city, address.state, address.pinCode, address.country].filter(Boolean).join(', ');
  if (addressText) document.text(addressText, 48, 296, { width: 300, height: 42 });
  let y = 355;
  document.rect(48, y, 516, 25).fill('#eaf5f7');
  document.fillColor('#20444f').font('Helvetica-Bold').fontSize(8).text('ITEM', 57, y + 8);
  document.text('TYPE', 308, y + 8);
  document.text('QTY', 410, y + 8, { width: 40, align: 'right' });
  document.text('UNIT', 455, y + 8, { width: 48, align: 'right' });
  document.text('TOTAL', 508, y + 8, { width: 48, align: 'right' });
  y += 25;
  for (const item of invoice.items || []) {
    const line = toPaise(item.price || 0) * Number(item.quantity || 1);
    document.fillColor('#273f49').font('Helvetica').fontSize(8).text(String(item.name || 'Product'), 57, y + 9, { width: 240, ellipsis: true });
    document.text(String(item.category || item.productType || 'Product'), 308, y + 9, { width: 90, ellipsis: true });
    document.text(String(item.quantity || 1), 410, y + 9, { width: 40, align: 'right' });
    document.text(invoiceCurrency(toPaise(item.price || 0)), 452, y + 9, { width: 52, align: 'right' });
    document.text(invoiceCurrency(line), 507, y + 9, { width: 49, align: 'right' });
    y += 31;
    if (y > 650) { document.addPage(); y = 55; }
  }
  y += 8;
  document.moveTo(340, y).lineTo(564, y).strokeColor('#cbd8dc').stroke();
  y += 14;
  const totals = [
    ['Subtotal', invoice.subtotalPaise],
    ...(invoice.discountAmountPaise ? [[`Discount${invoice.discountCode ? ` (${invoice.discountCode})` : ''}`, -invoice.discountAmountPaise]] : []),
    ...(invoice.serviceChargePaise ? [['Service charges', invoice.serviceChargePaise]] : []),
    ['Shipping', invoice.shippingPaise],
    ...(invoice.taxPaise ? [['Tax', invoice.taxPaise]] : []),
  ];
  for (const [label, value] of totals) {
    document.font('Helvetica').fontSize(9).fillColor('#47616b').text(label, 348, y, { width: 105 });
    document.text(`${Number(value) < 0 ? '−' : ''}${invoiceCurrency(Math.abs(value))}`, 453, y, { width: 103, align: 'right' });
    y += 17;
  }
  document.font('Helvetica-Bold').fontSize(11).fillColor('#0b2029').text('Total paid', 348, y + 2, { width: 105 });
  document.text(invoiceCurrency(invoice.totalPaise), 453, y + 2, { width: 103, align: 'right' });
  y += 30;
  document.rect(348, y, 216, 25).fill('#e5f8f2');
  const paymentLabel = invoice.paymentStatus === 'Paid' ? 'PAYMENT SUCCESSFUL' : `PAYMENT ${invoice.paymentStatus.toUpperCase()}`;
  document.fillColor('#24735e').font('Helvetica-Bold').fontSize(9).text(paymentLabel, 360, y + 8);
  document.fillColor('#637b84').font('Helvetica').fontSize(9).text('Thank you for shopping with Innovation Labs!', 48, 744, { width: 516, align: 'center' });
  document.end();
});

const createInvoiceForOrder = async (session, order) => {
  if (!order || order.paymentStatus !== 'Paid' || !order.orderId) return null;
  const existing = await Invoice.findOne({ orderId: order.orderId }).session(session).lean();
  if (existing) return existing;
  const walletPayment = order.paymentMethod === 'Wallet'
    ? await WalletTransaction.findOne({ orderId: order.orderId, type: 'Purchase', status: 'Successful' }).session(session).select('referenceId').lean()
    : null;
  const invoice = {
    invoiceId: `INV-${crypto.randomUUID()}`,
    invoiceNumber: `IL-${new Date().getFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    userId: order.userId,
    orderId: order.orderId,
    paymentId: order.razorpayId || walletPayment?.referenceId || (order.promoReservationId ? `promo-purchase:${order.promoReservationId}` : ''),
    paymentMethod: order.paymentMethod,
    customerName: order.userName,
    customerEmail: order.userEmail,
    billingAddress: order.buyerAddress || order.address || null,
    items: (order.items || []).map((item) => ({ name: item.name, category: item.category, quantity: item.quantity, price: item.price })),
    subtotalPaise: toPaise(order.subtotal || 0),
    discountAmountPaise: Number(order.discountAmountPaise || 0),
    discountCode: order.discountCode || '',
    serviceChargePaise: toPaise(order.codingCharge || 0) + toPaise(order.buildingCharge || 0),
    shippingPaise: toPaise(order.deliveryCharge || 0),
    taxPaise: 0,
    totalPaise: toPaise(order.total || 0),
    paymentStatus: 'Paid',
    createdAt: order.createdAt || new Date(),
  };
  invoice.pdfData = await renderInvoicePdf(invoice);
  const [created] = await Invoice.create([invoice], { session });
  return created.toObject();
};

const createInvoiceForStandalonePurchase = async (session, { userId, orderId, paymentId, paymentMethod, itemName, amountPaise }) => {
  const existing = await Invoice.findOne({ orderId }).session(session).lean();
  if (existing) return existing;
  const user = await User.findOne({ googleId: userId }).session(session).lean();
  const invoice = {
    invoiceId: `INV-${crypto.randomUUID()}`,
    invoiceNumber: `IL-${new Date().getFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    userId,
    orderId,
    paymentId,
    paymentMethod,
    customerName: user?.name || 'Innovation Labs customer',
    customerEmail: user?.email || '',
    billingAddress: user?.address || null,
    items: [{ name: itemName, category: 'Digital Purchase', quantity: 1, price: money(amountPaise) }],
    subtotalPaise: amountPaise,
    discountAmountPaise: 0,
    shippingPaise: 0,
    taxPaise: 0,
    totalPaise: amountPaise,
    paymentStatus: 'Paid',
    createdAt: new Date(),
  };
  invoice.pdfData = await renderInvoicePdf(invoice);
  const [created] = await Invoice.create([invoice], { session });
  return created.toObject();
};

const createCreditNoteForRefund = async (session, { userId, orderId, refundCaseId, amountPaise, reason = '' }) => {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return null;
  const existing = await CreditNote.findOne({ refundCaseId }).session(session).lean();
  if (existing) return existing;
  const invoice = await Invoice.findOne({ userId, orderId }).session(session).lean();
  if (!invoice) return null;
  const [creditNote] = await CreditNote.create([{
    creditNoteNumber: `IL-CN-${new Date().getFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    invoiceId: invoice.invoiceId,
    orderId,
    refundCaseId,
    userId,
    amountPaise,
    reason: String(reason).slice(0, 500),
  }], { session });
  return creditNote.toObject();
};

const releaseDiscountRedemptionForOrder = async (session, orderId) => {
  const redemption = await DiscountRedemption.findOne({ orderId, status: 'redeemed' }).session(session);
  if (redemption) {
    redemption.status = 'refunded';
    await redemption.save({ session });
    await DiscountCodeUsage.updateOne({ code: redemption.code, userId: redemption.userId, redemptionCount: { $gt: 0 } }, { $inc: { redemptionCount: -1 } }, { session });
    const purchase = await PurchasedDiscountCode.findOneAndUpdate(
      { purchaseId: redemption.purchaseId, redemptionCount: { $gt: 0 } },
      { $inc: { redemptionCount: -1 } },
      { new: true, session },
    ).select('isScratchReward scratchCardId redemptionCount maxRedemptions').lean();
    if (purchase?.isScratchReward) {
      await ScratchCard.updateOne(
        { scratchCardId: purchase.scratchCardId, status: { $in: ['scratched', 'redeemed'] } },
        { $set: { status: purchase.redemptionCount >= purchase.maxRedemptions ? 'redeemed' : 'scratched' } },
        { session },
      );
    }
    if (redemption.offerId) await DiscountCodeOffer.updateOne({ _id: redemption.offerId, redeemedCount: { $gt: 0 } }, { $inc: { redeemedCount: -1 } }, { session });
  }
  const scratch = await ScratchCard.findOne({ orderId }).session(session);
  if (scratch && scratch.status !== 'reversed') {
    scratch.status = 'reversed';
    await scratch.save({ session });
    await PurchasedDiscountCode.updateOne({ purchaseId: scratch.discountPurchaseId }, { $set: { fulfillmentStatus: 'rejected' } }, { session });
  }
  return redemption?.toObject() || null;
};

const discountItemIsEligible = (item, eligibility = {}) => {
  if (/plan|membership|subscription|wallet|promo code|discount code|service|delivery|ai credit/i.test(`${item.category || ''} ${item.name || ''}`)) return false;
  if (eligibility.eligibilityType === 'categories' && !(eligibility.eligibleCategories || []).includes(item.category)) return false;
  if (eligibility.eligibilityType === 'products' && !(eligibility.eligibleProductIds || []).includes(item.id || item.productId)) return false;
  return true;
};

const scratchEligibleAmountPaise = (order, settings) => {
  if (!order || order.orderType !== 'PRODUCT') return 0;
  const eligibleItemsPaise = (order.items || []).reduce((sum, item) => {
    if (!discountItemIsEligible(item, settings)) return sum;
    const amount = toPaise(item.price) * Number(item.quantity || 0);
    return Number.isSafeInteger(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
  return Math.max(0, eligibleItemsPaise - Number(order.discountAmountPaise || 0));
};

const generateUniqueDiscountCode = async (session) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const groups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''));
    const code = groups.join('-');
    const [offer, purchase] = await Promise.all([
      DiscountCodeOffer.exists({ code }).session(session),
      PurchasedDiscountCode.exists({ code }).session(session),
    ]);
    const [registered, walletCode] = await Promise.all([
      DiscountCodeRegistry.exists({ code }).session(session),
      PromoCode.exists({ code }).session(session),
    ]);
    if (!offer && !purchase && !registered && !walletCode) return code;
  }
  throw Object.assign(new Error('A unique Discount Promo Code could not be generated.'), { status: 409 });
};

const defaultScratchSettings = {
  enabled: true,
  thresholdPaise: 500000,
  rewardValuesPaise: [5000, 10000, 20000, 50000],
  discountType: 'fixed',
  minimumPurchasePaise: 0,
  eligibilityType: 'all',
  eligibleCategories: [],
  eligibleProductIds: [],
  expiryDays: 30,
  maxRedemptions: 1,
  transferable: false,
};

const createOrReserveRewardOffer = async (session, {
  rewardValue,
  discountType,
  expiresAt,
  minimumPurchasePaise,
  eligibilityType,
  eligibleCategories,
  eligibleProductIds,
  maxRedemptions,
}) => {
  const now = new Date();
  const offerFilter = {
    discountType,
    active: true,
    startsAt: { $lte: now },
    expiresAt: { $gt: now },
    availableQuantity: { $gt: 0 },
    purchasedCount: 0,
    minimumPurchasePaise,
    eligibilityType,
    eligibleCategories,
    eligibleProductIds,
    ...(discountType === 'fixed' ? { discountValuePaise: rewardValue } : { discountPercent: rewardValue }),
  };
  let offer = await DiscountCodeOffer.findOneAndUpdate(
    offerFilter,
    { $inc: { availableQuantity: -1, purchasedCount: 1 } },
    { new: true, session, sort: { createdAt: 1 } },
  );
  if (!offer) {
    const code = await generateUniqueDiscountCode(session);
    const [createdOffer] = await DiscountCodeOffer.create([{
      code,
      name: discountType === 'fixed' ? `₹${money(rewardValue)} Discount Promo Code` : `${money(rewardValue)}% Discount Promo Code`,
      source: 'SCRATCH_CARD',
      sellingPricePaise: 0,
      discountType,
      discountValuePaise: discountType === 'fixed' ? rewardValue : 0,
      discountPercent: discountType === 'percentage' ? money(rewardValue) : 0,
      startsAt: now,
      expiresAt,
      maxRedemptions,
      maxRedemptionsPerCustomer: maxRedemptions,
      availableQuantity: 1,
      purchasedCount: 0,
      redeemedCount: 0,
      minimumPurchasePaise,
      eligibilityType,
      eligibleCategories,
      eligibleProductIds,
      active: true,
    }], { session });
    await DiscountCodeRegistry.create([{
      code,
      sourceType: 'offer',
      sourceId: String(createdOffer._id),
    }], { session });
    offer = await DiscountCodeOffer.findOneAndUpdate(
      { _id: createdOffer._id, availableQuantity: { $gt: 0 } },
      { $inc: { availableQuantity: -1, purchasedCount: 1 } },
      { new: true, session },
    );
  }
  if (!offer) throw Object.assign(new Error('No discount promo code could be reserved for this reward.'), { status: 409 });
  return offer;
};

const createScratchCardReward = async (session, {
  userId,
  orderId,
  eligibleOrderAmountPaise,
  rewardValue,
  rewardType,
  settings,
  order,
}) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.expiryDays * 24 * 60 * 60 * 1000);
  const offer = await createOrReserveRewardOffer(session, {
    rewardValue,
    discountType: rewardType,
    expiresAt,
    minimumPurchasePaise: settings.minimumPurchasePaise || 0,
    eligibilityType: settings.eligibilityType || 'all',
    eligibleCategories: settings.eligibleCategories || [],
    eligibleProductIds: settings.eligibleProductIds || [],
    maxRedemptions: settings.maxRedemptions || 1,
  });
  const scratchCardId = `SC-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const purchaseId = `SCR-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const purchaseExpiresAt = new Date(Math.min(offer.expiresAt.getTime(), expiresAt.getTime()));
  await PurchasedDiscountCode.create([{
    purchaseId,
    offerId: offer._id,
    code: offer.code,
    userId,
    purchaserUserId: userId,
    orderId: orderId || `REWARD-${purchaseId}`,
    sellingPricePaise: 0,
    discountType: offer.discountType,
    discountValuePaise: offer.discountValuePaise,
    discountPercent: offer.discountPercent,
    minimumPurchasePaise: offer.minimumPurchasePaise,
    eligibilityType: offer.eligibilityType,
    eligibleCategories: offer.eligibleCategories,
    eligibleProductIds: offer.eligibleProductIds,
    maxRedemptions: settings.maxRedemptions || 1,
    maxRedemptionsPerCustomer: settings.maxRedemptions || 1,
    redemptionCount: 0,
    purchasedAt: now,
    expiresAt: purchaseExpiresAt,
    fulfillmentStatus: 'pending',
    isScratchReward: true,
    scratchCardId,
    transferable: settings.transferable,
    source: 'SCRATCH_CARD',
  }], { session });
  const [scratchCard] = await ScratchCard.create([{
    scratchCardId,
    userId,
    orderId: orderId || `REWARD-${purchaseId}`,
    eligibleOrderAmountPaise,
    rewardValuePaise: rewardValue,
    rewardType,
    discountPurchaseId: purchaseId,
    status: 'issued',
    createdAt: now,
  }], { session });
  if (order) {
    order.scratchCardId = scratchCardId;
    await order.save({ session });
  }
  await Notification.create([{
    userId,
    type: 'scratch_card_awarded',
    data: { scratchCardId, orderId },
    message: "Congratulations! You've unlocked a Scratch Card!",
  }], { session });
  return scratchCard.toObject();
};

const createScratchCardForOrder = async (session, order) => {
  if (!order || order.paymentStatus !== 'Paid' || !order.orderId || order.orderType !== 'PRODUCT') return null;
  if (await ScratchCard.exists({ orderId: order.orderId }).session(session)) return null;
  const settings = await ScratchSettings.findOne({ key: 'default' }).session(session).lean() || defaultScratchSettings;
  const eligibleOrderAmountPaise = scratchEligibleAmountPaise(order, settings);
  if (!settings.enabled || eligibleOrderAmountPaise <= settings.thresholdPaise) return null;
  const rewardValues = (settings.rewardValuesPaise || []).filter((amount) => Number.isSafeInteger(amount) && amount > 0);
  if (!rewardValues.length) return null;
  const rewardValue = rewardValues[crypto.randomInt(rewardValues.length)];
  return createScratchCardReward(session, {
    userId: order.userId,
    orderId: order.orderId,
    eligibleOrderAmountPaise,
    rewardValue,
    rewardType: settings.discountType || 'fixed',
    settings,
    order,
  });
};

const discountEligibleAmountPaise = (items, eligibility) => (items || []).reduce((sum, item) => {
  if (!discountItemIsEligible(item, eligibility)) return sum;
  const amount = toPaise(item.price) * Number(item.quantity || 0);
  return Number.isSafeInteger(amount) && amount > 0 ? sum + amount : sum;
}, 0);

const discountCodeContext = async ({ session, userId, code, items }) => {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(normalizedCode)) {
    let walletPromoQuery = PromoCode.findOne({ code: normalizedCode });
    if (session) walletPromoQuery = walletPromoQuery.session(session);
    if (await walletPromoQuery.select('_id').lean()) throw Object.assign(new Error('This is a Wallet Promo Code. It cannot be used for product discounts.'), { status: 400, code: 'WALLET_PROMO_NOT_DISCOUNT' });
    throw Object.assign(new Error('Invalid promo code. Please check your code and try again.'), { status: 400, code: 'DISCOUNT_INVALID' });
  }
  let offerQuery = DiscountCodeOffer.findOne({ code: normalizedCode });
  if (session) offerQuery = offerQuery.session(session);
  const offer = await offerQuery.lean();
  if (!offer) {
    let walletPromoQuery = PromoCode.findOne({ code: normalizedCode });
    if (session) walletPromoQuery = walletPromoQuery.session(session);
    if (await walletPromoQuery.select('_id').lean()) throw Object.assign(new Error('This is a Wallet Promo Code. It cannot be used for product discounts.'), { status: 400, code: 'WALLET_PROMO_NOT_DISCOUNT' });
  }
  const now = new Date();
  if (offer && (!offer.active || offer.startsAt > now || offer.expiresAt <= now)) {
    throw Object.assign(new Error('This promo code has expired.'), { status: 409, code: 'DISCOUNT_EXPIRED' });
  }
  if (offer && offer.redeemedCount >= offer.maxRedemptions) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
  let purchasesQuery = PurchasedDiscountCode.find({
    userId,
    code: normalizedCode,
    fulfillmentStatus: 'fulfilled',
    expiresAt: { $gt: now },
    $expr: { $lt: ['$redemptionCount', '$maxRedemptions'] },
  }).sort({ purchasedAt: 1 });
  if (session) purchasesQuery = purchasesQuery.session(session);
  const purchase = await purchasesQuery.lean();
  if (!purchase.length) {
    let expiredQuery = PurchasedDiscountCode.findOne({ userId, code: normalizedCode, fulfillmentStatus: 'fulfilled', expiresAt: { $lte: now } });
    if (session) expiredQuery = expiredQuery.session(session);
    if (await expiredQuery.select('_id').lean()) throw Object.assign(new Error('This promo code has expired.'), { status: 410, code: 'DISCOUNT_EXPIRED' });
    let pendingQuery = PurchasedDiscountCode.findOne({ userId, code: normalizedCode, fulfillmentStatus: 'pending' });
    if (session) pendingQuery = pendingQuery.session(session);
    if (await pendingQuery.select('_id').lean()) throw Object.assign(new Error('This promo code is not fulfilled yet.'), { status: 409, code: 'DISCOUNT_NOT_FULFILLED' });
    let redeemedQuery = DiscountCodeUsage.findOne({ code: normalizedCode, userId });
    if (session) redeemedQuery = redeemedQuery.session(session);
    const usage = await redeemedQuery.lean();
    const perCustomerLimit = offer?.maxRedemptionsPerCustomer || 1;
    if (usage && usage.redemptionCount >= perCustomerLimit) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
    throw Object.assign(new Error('Invalid promo code. Please check your code and try again.'), { status: 400, code: 'DISCOUNT_INVALID' });
  }
  const selectedPurchase = purchase[0];
  const perCustomerLimit = Math.min(offer?.maxRedemptionsPerCustomer || selectedPurchase.maxRedemptionsPerCustomer, selectedPurchase.maxRedemptionsPerCustomer);
  let usageQuery = DiscountCodeUsage.findOne({ code: normalizedCode, userId });
  if (session) usageQuery = usageQuery.session(session);
  const usage = await usageQuery.lean();
  if ((usage?.redemptionCount || 0) >= perCustomerLimit) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
  const eligibility = selectedPurchase;
  const eligibleAmountPaise = discountEligibleAmountPaise(items, eligibility);
  const minimumPurchasePaise = Math.max(offer?.minimumPurchasePaise || 0, selectedPurchase.minimumPurchasePaise || 0);
  if (eligibleAmountPaise <= 0) throw Object.assign(new Error('Add eligible products to your cart before applying a discount code.'), { status: 409, code: 'DISCOUNT_NO_ELIGIBLE_ITEMS' });
  if (eligibleAmountPaise < minimumPurchasePaise) throw Object.assign(new Error(`This promo code requires at least ₹${money(minimumPurchasePaise).toLocaleString('en-IN')} in eligible products.`), { status: 409, code: 'DISCOUNT_MINIMUM' });
  const discountType = selectedPurchase.discountType;
  const calculated = discountType === 'percentage'
    ? Math.round(eligibleAmountPaise * selectedPurchase.discountPercent / 100)
    : selectedPurchase.discountValuePaise;
  const discountAmountPaise = Math.max(0, Math.min(eligibleAmountPaise, calculated));
  if (!discountAmountPaise) throw Object.assign(new Error('This promo code does not apply a discount to these products.'), { status: 409, code: 'DISCOUNT_NOT_APPLICABLE' });
  return { offer, purchase: selectedPurchase, code: normalizedCode, eligibleAmountPaise, discountAmountPaise };
};

const redeemDiscountCode = async (session, { userId, code, items, orderId }) => {
  const context = await discountCodeContext({ session, userId, code, items });
  const now = new Date();
  const usageLimit = Math.min(context.offer?.maxRedemptionsPerCustomer || context.purchase.maxRedemptionsPerCustomer, context.purchase.maxRedemptionsPerCustomer);
  try {
    await DiscountCodeUsage.findOneAndUpdate(
      { code: context.code, userId, redemptionCount: { $lt: usageLimit } },
      { $setOnInsert: { code: context.code, userId }, $inc: { redemptionCount: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    );
  } catch (error) {
    if (error.code === 11000) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
    throw error;
  }
  const updatedPurchase = await PurchasedDiscountCode.findOneAndUpdate(
    { _id: context.purchase._id, fulfillmentStatus: 'fulfilled', expiresAt: { $gt: now }, redemptionCount: { $lt: context.purchase.maxRedemptions } },
    { $inc: { redemptionCount: 1 } },
    { new: true, session },
  );
  if (!updatedPurchase) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
  if (context.offer) {
    const offerUpdate = await DiscountCodeOffer.updateOne(
      { _id: context.offer._id, active: true, startsAt: { $lte: now }, expiresAt: { $gt: now }, redeemedCount: { $lt: context.offer.maxRedemptions } },
      { $inc: { redeemedCount: 1 } },
      { session },
    );
    if (!offerUpdate.modifiedCount) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
  }
  const redemptionId = `DR-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  await DiscountRedemption.create([{
    redemptionId,
    purchaseId: context.purchase.purchaseId,
    offerId: context.offer?._id || null,
    code: context.code,
    userId,
    orderId,
    discountAmountPaise: context.discountAmountPaise,
    status: 'redeemed',
    redeemedAt: now,
  }], { session });
  if (context.purchase.isScratchReward) {
    const scratchCard = await ScratchCard.findOne({
      scratchCardId: context.purchase.scratchCardId,
      userId,
      status: { $in: ['scratched', 'redeemed'] },
    }).session(session);
    if (!scratchCard) throw Object.assign(new Error('The Scratch Card reward is no longer available.'), { status: 409, code: 'DISCOUNT_USED' });
    scratchCard.status = updatedPurchase.redemptionCount >= updatedPurchase.maxRedemptions ? 'redeemed' : 'scratched';
    await scratchCard.save({ session });
  }
  return context;
};

const resolveDiscountRecipient = async (session, buyerUserId, buyerEmail, recipientEmail) => {
  const normalizedEmail = String(recipientEmail || '').trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail === String(buyerEmail).toLowerCase()) return { userId: buyerUserId, email: buyerEmail, gift: false };
  const recipient = await User.findOne({ email: normalizedEmail }).select('googleId email').session(session).lean();
  if (!recipient) throw Object.assign(new Error('The gift recipient must have a registered Innovation Labs account.'), { status: 404 });
  return { userId: recipient.googleId, email: recipient.email, gift: true };
};

const purchaseDiscountOffer = async (session, {
  offerId,
  userId,
  userName,
  userEmail,
  recipientEmail,
  paymentMethod,
  paymentId,
  idempotencyKey,
  pin,
}) => {
  if (paymentMethod === 'Razorpay' && paymentId) {
    const existingOrder = await Order.findOne({ userId, razorpayId: paymentId, orderType: 'DISCOUNT_CODE' }).session(session).lean();
    if (existingOrder) {
      if (String(existingOrder.items?.[0]?.discountOfferId) !== String(offerId)) throw Object.assign(new Error('This payment was already used for a different discount offer.'), { status: 409 });
      const purchase = await PurchasedDiscountCode.findOne({ orderId: existingOrder.orderId }).session(session).lean();
      return { order: existingOrder, purchase, duplicate: true };
    }
  }
  if (paymentMethod === 'Wallet') {
    const referenceId = `discount-wallet:${idempotencyKey}`;
    const existingTransaction = await WalletTransaction.findOne({ userId, referenceId }).session(session).lean();
    if (existingTransaction) {
      const existingOrder = await Order.findOne({ userId, orderId: existingTransaction.orderId }).session(session).lean();
      const purchase = await PurchasedDiscountCode.findOne({ orderId: existingTransaction.orderId }).session(session).lean();
      if (existingOrder && purchase) {
        if (String(existingOrder.items?.[0]?.discountOfferId) !== String(offerId)) throw Object.assign(new Error('This purchase reference was already used for a different offer.'), { status: 409 });
        return { order: existingOrder, purchase, duplicate: true };
      }
      throw Object.assign(new Error('This discount-code purchase reference has already been used.'), { status: 409 });
    }
  }
  const now = new Date();
  const recipient = await resolveDiscountRecipient(session, userId, userEmail, recipientEmail);
  const offer = await DiscountCodeOffer.findOneAndUpdate(
    { _id: offerId, active: true, startsAt: { $lte: now }, expiresAt: { $gt: now }, availableQuantity: { $gt: 0 } },
    { $inc: { availableQuantity: -1, purchasedCount: 1 } },
    { new: true, session },
  );
  if (!offer) throw Object.assign(new Error('This discount offer is no longer available.'), { status: 409 });
  let wallet = null;
  let balanceBeforePaise = 0;
  if (paymentMethod === 'Wallet') {
    wallet = await Wallet.findOne({ userId }).session(session);
    if (!wallet?.pinHash) throw Object.assign(new Error('Set up your Wallet PIN before paying for this discount code.'), { status: 409 });
    if (!verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
    if (wallet.balancePaise < offer.sellingPricePaise) throw Object.assign(new Error('Insufficient Wallet balance.'), { status: 402 });
    balanceBeforePaise = wallet.balancePaise;
    wallet.balancePaise -= offer.sellingPricePaise;
    await wallet.save({ session });
  }
  const orderId = `IL-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const purchaseId = `DCP-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const [order] = await Order.create([{
    orderId,
    orderType: 'DISCOUNT_CODE',
    purchaseType: 'online',
    recipientType: recipient.gift ? 'gift' : 'myself',
    userId,
    userName,
    userEmail,
    items: [{ id: `discount-offer-${offer._id}`, discountOfferId: String(offer._id), name: offer.name, category: 'Discount Code', price: money(offer.sellingPricePaise), quantity: 1 }],
    address: null,
    recipientUserId: recipient.gift ? recipient.userId : undefined,
    recipientEmail: recipient.gift ? recipient.email : undefined,
    deliveryRequired: false,
    discountCodePurchaseId: purchaseId,
    service: 'parts',
    projectDescription: '',
    subtotal: money(offer.sellingPricePaise),
    codingCharge: 0,
    buildingCharge: 0,
    deliveryCharge: 0,
    total: money(offer.sellingPricePaise),
    paymentStatus: 'Paid',
    paymentMethod,
    walletBalanceAfterPaise: wallet?.balancePaise,
    orderStatus: 'Confirmed',
    approvalStatus: 'not_required',
    statusHistory: [{ status: 'Confirmed', note: 'Discount Promo Code purchase confirmed and fulfilled.', createdAt: now }],
    razorpayId: paymentId || undefined,
  }], { session });
  const [purchase] = await PurchasedDiscountCode.create([{
    purchaseId,
    offerId: offer._id,
    code: offer.code,
    userId: recipient.userId,
    purchaserUserId: userId,
    recipientEmail: recipient.gift ? recipient.email : undefined,
    orderId,
    sellingPricePaise: offer.sellingPricePaise,
    discountType: offer.discountType,
    discountValuePaise: offer.discountValuePaise,
    discountPercent: offer.discountPercent,
    minimumPurchasePaise: offer.minimumPurchasePaise,
    eligibilityType: offer.eligibilityType || 'all',
    eligibleCategories: offer.eligibleCategories || [],
    eligibleProductIds: offer.eligibleProductIds || [],
    maxRedemptions: offer.maxRedemptions,
    maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer,
    purchasedAt: now,
    expiresAt: offer.expiresAt,
    fulfillmentStatus: 'fulfilled',
    transferable: false,
  }], { session });
  if (paymentMethod === 'Wallet') {
    await WalletTransaction.create([{
      userId,
      type: 'Purchase',
      amountPaise: -offer.sellingPricePaise,
      balanceBeforePaise,
      balanceAfterPaise: wallet.balancePaise,
      referenceId: `discount-wallet:${idempotencyKey}`,
      orderId,
      description: `Discount Promo Code purchase ${orderId}`,
      status: 'Successful',
    }], { session });
  }
  await createInvoiceForOrder(session, order);
  await Notification.create([{
    userId: recipient.userId,
    type: 'discount_code_fulfilled',
    data: { purchaseId, orderId },
    message: `Your Discount Promo Code ${offer.code} is ready to use in your account.`,
  }], { session });
  return { order: order.toObject(), purchase: purchase.toObject(), wallet: wallet?.toObject(), duplicate: false };
};

const fulfillDiscountOfferItems = async (session, items, { userId, orderId }) => {
  const fulfilledCodes = [];
  for (const item of items.filter((orderItem) => orderItem.discountOfferId)) {
    const now = new Date();
    const offer = await DiscountCodeOffer.findOneAndUpdate(
      {
        _id: item.discountOfferId,
        active: true,
        startsAt: { $lte: now },
        expiresAt: { $gt: now },
        availableQuantity: { $gte: item.quantity },
      },
      { $inc: { availableQuantity: -item.quantity, purchasedCount: item.quantity } },
      { new: true, session },
    );
    if (!offer) throw Object.assign(new Error(`${item.name} is no longer available in the requested quantity.`), { status: 409 });
    const purchases = Array.from({ length: item.quantity }, () => ({
      purchaseId: `DCP-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
      offerId: offer._id,
      code: offer.code,
      userId,
      purchaserUserId: userId,
      orderId,
      sellingPricePaise: offer.sellingPricePaise,
      discountType: offer.discountType,
      discountValuePaise: offer.discountValuePaise,
      discountPercent: offer.discountPercent,
      minimumPurchasePaise: offer.minimumPurchasePaise,
      eligibilityType: offer.eligibilityType || 'all',
      eligibleCategories: offer.eligibleCategories || [],
      eligibleProductIds: offer.eligibleProductIds || [],
      maxRedemptions: offer.maxRedemptions,
      maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer,
      purchasedAt: now,
      expiresAt: offer.expiresAt,
      fulfillmentStatus: 'fulfilled',
      transferable: false,
      source: offer.source || 'ADMIN',
    }));
    const createdPurchases = await PurchasedDiscountCode.create(purchases, { session });
    fulfilledCodes.push(...createdPurchases.map((purchase) => ({
      code: purchase.code,
      purchaseId: purchase.purchaseId,
      offerName: offer.name,
      discountType: purchase.discountType,
      discountValue: purchase.discountType === 'fixed' ? money(purchase.discountValuePaise) : purchase.discountPercent,
      discountLabel: purchase.discountType === 'fixed' ? `₹${money(purchase.discountValuePaise)} off` : `${purchase.discountPercent}% off`,
    })));
  }
  return fulfilledCodes;
};

const discountCodesForOrder = async (orderId, session = null) => {
  let query = PurchasedDiscountCode.find({ orderId, fulfillmentStatus: 'fulfilled' }).sort({ purchasedAt: 1 });
  if (session) query = query.session(session);
  const purchases = await query.lean();
  return purchases.map((purchase) => ({
    code: purchase.code,
    purchaseId: purchase.purchaseId,
    discountType: purchase.discountType,
    discountValue: purchase.discountType === 'fixed' ? money(purchase.discountValuePaise) : purchase.discountPercent,
    discountLabel: purchase.discountType === 'fixed' ? `₹${money(purchase.discountValuePaise)} off` : `${purchase.discountPercent}% off`,
  }));
};

const activatePromoCode = (promo, activatedAt = new Date()) => {
  const validitySeconds = Number(promo.validitySeconds || 30 * 24 * 60 * 60);
  if (!Number.isSafeInteger(validitySeconds) || validitySeconds < 60) {
    throw Object.assign(new Error('The Promo Code validity is invalid.'), { status: 409 });
  }
  promo.activatedAt = activatedAt;
  promo.expiresAt = new Date(activatedAt.getTime() + validitySeconds * 1000);
  if (!Number.isFinite(promo.expiresAt.getTime())) throw Object.assign(new Error('The Promo Code expiry timestamp is invalid.'), { status: 409 });
};

const buyerOrderView = (order) => {
  const value = order?.toObject ? order.toObject() : order;
  const shouldHidePromoCode = value?.recipientType === 'gift'
    || value?.orderType === 'PROMO_CODE' && value?.purchaseType === 'offline' && !value?.promoActivatedAt;
  return shouldHidePromoCode ? { ...value, promoCode: undefined } : value;
};

const adminOrdersView = async (orders) => {
  const ordersMissingCode = orders.filter((order) => order.orderType === 'PROMO_CODE' && !order.promoCode && order.promoCodeId && order.orderId);
  if (!ordersMissingCode.length) return orders;
  const promoCodes = await PromoCode.find({
    _id: { $in: ordersMissingCode.map((order) => order.promoCodeId) },
    orderId: { $in: ordersMissingCode.map((order) => order.orderId) },
  }).select('_id orderId code').lean();
  const codesByOrder = new Map(promoCodes.map((promo) => [`${promo._id}:${promo.orderId}`, promo.code]));
  return orders.map((order) => {
    const promoCode = codesByOrder.get(`${order.promoCodeId}:${order.orderId}`);
    return order.orderType === 'PROMO_CODE' && !order.promoCode && promoCode ? { ...order, promoCode } : order;
  });
};

const completePromoCodeOrder = async (session, {
  promo,
  reservationId,
  userId,
  userName,
  userEmail,
  paymentMethod,
  idempotencyKey,
  razorpayPaymentId,
  walletBalanceAfterPaise,
}) => {
  const now = new Date();
  const orderId = `IL-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  activatePromoCode(promo, now);
  const recipientUserId = promo.recipientType === 'gift' ? promo.giftRecipientId : userId;
  if (!recipientUserId) throw Object.assign(new Error('The gift recipient must be verified before payment.'), { status: 409 });
  const recipient = promo.recipientType === 'gift'
    ? await User.findOne({ googleId: recipientUserId }).session(session).lean()
    : null;
  if (promo.recipientType === 'gift' && (!recipient || recipient.email !== promo.giftRecipientEmail)) {
    throw Object.assign(new Error('The verified gift recipient could not be confirmed.'), { status: 409 });
  }
  const recipientName = recipient?.name || userName;
  const purchasedPromo = await PromoCode.findOneAndUpdate(
    {
      _id: promo._id,
      status: 'reserved',
      reservationId,
      'reservationOwner.userId': userId,
      reservationExpiresAt: { $gt: now },
      paymentMethod,
    },
    {
      $set: {
        status: 'purchased',
        purchasedBy: { userId: recipientUserId, name: recipientName, email: recipient?.email || userEmail },
        giftBuyerId: userId,
        giftBuyerName: userName,
        giftBuyerEmail: userEmail,
        purchasedAt: now,
        activatedAt: promo.activatedAt,
        expiresAt: promo.expiresAt,
        purchaseIdempotencyKey: idempotencyKey,
        orderId,
        razorpayPaymentId: razorpayPaymentId || undefined,
      },
    },
    { new: true, session },
  );
  if (!purchasedPromo) throw Object.assign(new Error('This Promo Code reservation expired or is no longer available.'), { status: 409 });

  const amount = money(purchasedPromo.amountPaise);
  const [order] = await Order.create([{
    orderId,
    orderType: 'PROMO_CODE',
    purchaseType: 'online',
    recipientType: promo.recipientType || 'myself',
    userId,
    userName,
    userEmail,
    items: [{ id: `promo-${purchasedPromo._id}`, name: 'Promo Code', category: 'Promo Code', price: amount, quantity: 1 }],
    address: null,
    deliveryRequired: false,
    promoCodeId: purchasedPromo._id,
    promoReservationId: reservationId,
    promoCode: purchasedPromo.code,
    promoCodeAmountPaise: purchasedPromo.amountPaise,
    promoCodeStatus: 'PURCHASED',
    promoActivationStatus: 'active',
    promoActivatedAt: purchasedPromo.activatedAt,
    promoExpiresAt: purchasedPromo.expiresAt,
    promoMaxUses: purchasedPromo.maxUses || 10,
    promoSuccessfulUses: purchasedPromo.successfulUses || 0,
    recipientUserId,
    recipientEmail: recipient?.email || undefined,
    service: 'parts',
    projectDescription: '',
    subtotal: amount,
    codingCharge: 0,
    buildingCharge: 0,
    deliveryCharge: 0,
    total: amount,
    paymentStatus: 'Paid',
    paymentMethod,
    walletBalanceAfterPaise,
    orderStatus: 'Confirmed',
    approvalStatus: 'not_required',
    statusHistory: [{ status: 'Confirmed', note: 'Online Promo Code purchase confirmed.', createdAt: now }],
    razorpayId: razorpayPaymentId,
  }], { session });
  await awardRewardPointsForOrder(session, order);
  await createInvoiceForOrder(session, order);
  if (promo.recipientType === 'gift') {
    await Notification.create([{
      userId: recipientUserId,
      type: 'promo_gift_received',
      data: { orderId, buyerName: userName, buyerEmail: userEmail, promoName: 'Digital Wallet Credit', amount: money(purchasedPromo.amountPaise), receivedAt: now },
      message: `You received a Promo Code gift from ${userName}. It is ready in your Wallet.`,
    }, {
      userId,
      type: 'promo_gift_sent',
      data: { orderId, recipientEmail: recipient.email, amount: money(purchasedPromo.amountPaise) },
      message: `Your Promo Code gift order ${orderId} was confirmed and sent to ${recipient.email}.`,
    }], { session, ordered: true });
  } else {
    await Notification.create([{ userId, message: `Promo Code order ${orderId} was confirmed. The code is ready in your Wallet.` }], { session });
  }
  return { promoCode: purchasedPromo.toObject(), order: order.toObject() };
};

const createOfflinePromoCodeOrder = async (session, {
  promo,
  userId,
  userName,
  userEmail,
  address,
  buyerAddress,
  recipientAddress,
  recipientUserId,
  recipientEmail,
  recipientType: requestedRecipientType,
  paymentMethod,
  idempotencyKey,
  razorpayPaymentId,
  walletBalanceAfterPaise,
}) => {
  const now = new Date();
  const recipientType = requestedRecipientType || promo.recipientType || 'myself';
  if (recipientType === 'gift') promo.maxUses = 1;
  const orderId = `IL-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  promo.status = 'pending_approval';
  promo.purchaseType = 'offline';
  promo.giftRecipientId = recipientType === 'gift' ? recipientUserId || undefined : undefined;
  promo.giftRecipientEmail = recipientType === 'gift' ? recipientEmail || undefined : undefined;
  promo.giftBuyerId = userId;
  promo.giftBuyerName = userName;
  promo.giftBuyerEmail = userEmail;
  promo.purchaseIdempotencyKey = idempotencyKey;
  promo.razorpayPaymentId = razorpayPaymentId || undefined;
  promo.purchasedAt = now;
  promo.orderId = orderId;
  await promo.save({ session });
  const [order] = await Order.create([{
    orderId,
    orderType: 'PROMO_CODE',
    purchaseType: 'offline',
    recipientType: recipientType || 'myself',
    userId,
    userName,
    userEmail,
    items: [{ id: `promo-${promo._id}`, name: 'Digital Wallet Credit', category: 'Promo Code', price: money(promo.amountPaise), quantity: 1 }],
    address: recipientAddress || address,
    buyerAddress,
    recipientAddress: recipientAddress || address,
    recipientUserId: recipientUserId || undefined,
    recipientEmail: recipientEmail || undefined,
    deliveryRequired: true,
    promoCodeId: promo._id,
    promoReservationId: promo.reservationId,
    promoCode: promo.code,
    promoCodeAmountPaise: promo.amountPaise,
    service: 'parts',
    projectDescription: '',
    subtotal: money(promo.amountPaise),
    codingCharge: 0,
    buildingCharge: 0,
    deliveryCharge: 0,
    total: money(promo.amountPaise),
    paymentStatus: 'Paid',
    paymentMethod,
    walletBalanceAfterPaise,
    orderStatus: 'Pending Admin Approval',
    approvalStatus: 'pending',
    promoActivationStatus: 'pending',
    promoMaxUses: promo.maxUses || 10,
    promoSuccessfulUses: promo.successfulUses || 0,
    statusHistory: [{ status: 'Pending Admin Approval', note: 'Offline Promo Code order paid and awaiting admin approval.', createdAt: now }],
    razorpayId: razorpayPaymentId,
  }], { session });
  await createInvoiceForOrder(session, order);
  await Notification.create([{
    userId,
    message: `Offline Promo Code order ${orderId} was paid and is awaiting admin approval. The code will be activated after approval.`,
  }], { session });
  return { order: order.toObject(), promoCode: null };
};

const validateCreditQuantity = (value) => {
  const credits = Number(value);
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > aiCreditMaxPurchase) {
    throw Object.assign(new Error(`Enter a whole number of credits between 1 and ${aiCreditMaxPurchase.toLocaleString('en-IN')}.`), { status: 400 });
  }
  return credits;
};

const creditPurchaseView = (purchase) => ({
  purchaseId: purchase.purchaseId,
  credits: purchase.credits,
  pricePerCredit: money(purchase.pricePerCreditPaise),
  totalAmount: money(purchase.totalAmountPaise),
  currency: purchase.currency,
  paymentMethod: purchase.paymentMethod,
  status: purchase.status,
  razorpayOrderId: purchase.razorpayOrderId || null,
  previousBalance: purchase.previousBalance,
  newBalance: purchase.newBalance,
  completedAt: purchase.completedAt || null,
});

const addPurchasedCredits = async (session, purchase, paymentReference) => {
  const current = await AICredits.findOne({ userId: purchase.userId }).session(session);
  const previousBalance = current?.balance || 0;
  const credits = await AICredits.findOneAndUpdate(
    { userId: purchase.userId },
    { $inc: { balance: purchase.credits, purchasedCredits: purchase.credits } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session },
  );
  await AICreditTransaction.create([{
    userId: purchase.userId,
    type: 'added',
    amount: purchase.credits,
    action: 'credit_purchase',
    reference: paymentReference,
    purchaseId: purchase.purchaseId,
    paymentMethod: purchase.paymentMethod,
    amountPaise: purchase.totalAmountPaise,
    previousBalance,
    balanceAfter: credits.balance,
  }], { session });
  purchase.status = 'completed';
  purchase.previousBalance = previousBalance;
  purchase.newBalance = credits.balance;
  purchase.completedAt = new Date();
  await purchase.save({ session });
  await createInvoiceForStandalonePurchase(session, {
    userId: purchase.userId,
    orderId: `AI-${purchase.purchaseId}`,
    paymentId: paymentReference,
    paymentMethod: purchase.paymentMethod,
    itemName: `${purchase.credits.toLocaleString('en-IN')} AI Credits`,
    amountPaise: purchase.totalAmountPaise,
  });
  return { credits, purchase };
};

const resolveOrderItems = async (items, userId) => {
  if (!Array.isArray(items) || !items.length || items.length > 50) {
    throw Object.assign(new Error('The order must contain at least one item.'), { status: 400 });
  }
  const customIds = items.filter((item) => item?.customOrderId).map((item) => item.customOrderId);
  if (customIds.some((id) => !mongoose.isValidObjectId(id))) {
    throw Object.assign(new Error('A custom item is invalid.'), { status: 400 });
  }
  const customOrders = customIds.length
    ? await CustomOrder.find({ _id: { $in: customIds }, userId, status: 'Accepted' }).lean()
    : [];
  const customOrderById = new Map(customOrders.map((order) => [String(order._id), order]));
  const safeItems = [];
  for (const item of items) {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw Object.assign(new Error('Item quantity is invalid.'), { status: 400 });
    }
    if ((item?.promoReservationId || item?.promoCodeId || String(item?.id || '').startsWith('promo-')) && quantity !== 1) {
      throw Object.assign(new Error('Promo Codes can only be purchased one at a time.'), { status: 400 });
    }
    if (item?.discountOfferId) {
      if (!mongoose.isValidObjectId(item.discountOfferId)) throw Object.assign(new Error('A Discount Promo Code offer is invalid.'), { status: 400 });
      const now = new Date();
      const offer = await DiscountCodeOffer.findOne({
        _id: item.discountOfferId,
        active: true,
        startsAt: { $lte: now },
        expiresAt: { $gt: now },
        availableQuantity: { $gte: quantity },
      }).select('_id name sellingPricePaise availableQuantity').lean();
      if (!offer) throw Object.assign(new Error('This Discount Promo Code is no longer available in the requested quantity.'), { status: 409 });
      safeItems.push({
        id: `discount-offer-${offer._id}`,
        discountOfferId: String(offer._id),
        name: offer.name,
        category: 'Discount Promo Code',
        price: money(offer.sellingPricePaise),
        quantity,
      });
      continue;
    }
    if (item.customOrderId) {
      const customOrder = customOrderById.get(String(item.customOrderId));
      if (!customOrder) throw Object.assign(new Error('An accepted custom item is no longer available.'), { status: 409 });
      safeItems.push({ id: `custom-${customOrder._id}`, customOrderId: String(customOrder._id), name: customOrder.requestedItem, category: 'Custom Order', price: customOrder.price, quantity });
    } else {
      const productId = String(item?.id || '');
      const inventoryItem = await InventoryItem.findOne({ productId }).lean();
      if (!inventoryItem) throw Object.assign(new Error('An item in the cart is unavailable.'), { status: 400 });
      if (inventoryItem.status === 'Out of Stock') throw Object.assign(new Error(`${inventoryItem.name} is currently out of stock.`), { status: 409 });
      if (inventoryItem.stock < quantity) throw Object.assign(new Error(`Insufficient stock for ${inventoryItem.name}.`), { status: 409 });
      safeItems.push({
        id: productId,
        name: inventoryItem.name,
        category: inventoryItem.category || 'Other Components',
        price: inventoryItem.pricePaise / 100,
        quantity,
      });
    }
  }
  return { safeItems, customOrders };
};

const calculateOrder = (safeItems, service = 'parts') => {
  const subtotalPaise = safeItems.reduce((sum, item) => sum + toPaise(item.price) * item.quantity, 0);
  const physicalItems = safeItems.filter((item) => !item.discountOfferId);
  const physicalSubtotalPaise = physicalItems.reduce((sum, item) => sum + toPaise(item.price) * item.quantity, 0);
  const itemCount = physicalItems.reduce((sum, item) => sum + item.quantity, 0);
  const codingChargePaise = itemCount && ['coding', 'full'].includes(service) ? toPaise(700 + Math.max(0, itemCount - 3) * 300) : 0;
  const buildingChargePaise = itemCount && ['building', 'full'].includes(service) ? toPaise(1200) : 0;
  const deliveryChargePaise = physicalSubtotalPaise > toPaise(800) ? 0 : physicalSubtotalPaise > 0 ? toPaise(40) : 0;
  return {
    subtotalPaise,
    codingChargePaise,
    buildingChargePaise,
    deliveryChargePaise,
    totalPaise: subtotalPaise + codingChargePaise + buildingChargePaise + deliveryChargePaise,
  };
};

const catalogPrices = new Map([
  ['arduino-uno', ['Arduino Uno', 'Arduino Uno', 980]],
  ['ultrasonic-sensor-hc-sr04', ['Ultrasonic Sensor HC-SR04', 'Sensors', 220]],
  ['ir-obstacle-sensor', ['IR Obstacle Sensor', 'Sensors', 90]],
  ['ldr-light-sensor', ['LDR Light Sensor', 'Sensors', 45]],
  ['pir-motion-sensor', ['PIR Motion Sensor', 'Sensors', 180]],
  ['dht11-temperature-humidity-sensor', ['DHT11 Temperature & Humidity Sensor', 'Sensors', 140]],
  ['soil-moisture-sensor', ['Soil Moisture Sensor', 'Sensors', 110]],
  ['rain-sensor', ['Rain Sensor', 'Sensors', 120]],
  ['flame-sensor', ['Flame Sensor', 'Sensors', 95]],
  ['sound-noise-sensor', ['Sound/Noise Sensor', 'Sensors', 85]],
  ['water-level-sensor', ['Water Level Sensor', 'Sensors', 100]],
  ['gas-sensor', ['Gas Sensor', 'Sensors', 160]],
  ['touch-sensor', ['Touch Sensor', 'Sensors', 55]],
  ['pulse-heart-sensor', ['Pulse/Heart Sensor', 'Sensors', 240]],
  ['ir-receiver-sensor', ['IR Receiver Sensor', 'Sensors', 65]],
  ['joystick-module', ['Joystick Module', 'Modules', 130]],
  ['relay-module', ['Relay Module', 'Modules', 95]],
  ['12v-dc-gear-motor', ['12V DC Gear Motor', 'Motors', 680]],
  ['sg90-servo-motor', ['SG90 Servo Motor', 'Motors', 160]],
  ['high-torque-servo-motor', ['High Torque Servo Motor', 'Motors', 620]],
  ['l298n-motor-driver', ['L298N Motor Driver', 'Motor Drivers', 420]],
  ['i2c-lcd-display', ['I2C LCD Display', 'Displays', 260]],
  ['7-segment-display', ['7-Segment Display', 'Displays', 75]],
  ['oled-display', ['OLED Display', 'Displays', 550]],
  ['passive-buzzer', ['Passive Buzzer', 'Buzzers & LEDs', 35]],
  ['leds', ['LEDs', 'Buzzers & LEDs', 20]],
  ['push-buttons', ['Push Buttons', 'Components', 15]],
  ['potentiometer', ['Potentiometer', 'Components', 35]],
  ['breadboard', ['Breadboard', 'Power & Wiring', 120]],
  ['jumper-wires', ['Jumper Wires', 'Power & Wiring', 90]],
  ['battery-holder', ['Battery Holder', 'Power & Wiring', 45]],
  ['9v-battery', ['9V Battery', 'Power & Wiring', 55]],
  ['dc-power-supply-module', ['DC Power Supply Module', 'Power & Wiring', 180]],
]);

const seedInventory = async () => {
  if (mongoose.connection.readyState !== 1) return;
  const catalogEntries = [...catalogPrices.entries()];
  const categoryCorrections = catalogEntries
    .filter(([, [, category]]) => category !== 'Other Components')
    .map(([productId, [, category]]) => ({
      updateOne: {
        filter: { productId, category: { $in: ['Other Components', null, ''] } },
        update: { $set: { category } },
      },
    }));
  if (categoryCorrections.length) await InventoryItem.bulkWrite(categoryCorrections);
  const operations = catalogEntries.map(([productId, [name, category, price]]) => ({
    updateOne: {
      filter: { productId },
      update: {
        $setOnInsert: {
          productId,
          name,
          category,
          pricePaise: toPaise(price),
          description: `${name} for Arduino prototypes, robotics, and hands-on electronics projects.`,
          stock: 10,
          status: 'In Stock',
        },
      },
      upsert: true,
    },
  }));
  if (operations.length) await InventoryItem.bulkWrite(operations);
};

const validateAddress = (address) => address &&
  ['fullName', 'phoneNumber', 'addressLine1', 'city', 'state', 'pinCode', 'country']
    .every((field) => typeof address[field] === 'string' && address[field].trim());

const orderRequiresDelivery = (items) => (items || []).some((item) => !item.discountOfferId);

const resolvePromoRecipient = async (session, { promo, userId, userEmail, recipientEmail = '' }) => {
  if (promo.recipientType !== 'gift') return { recipientUserId: null, recipientEmail: '' };
  if (promo.purchaseType === 'online') {
    if (!promo.giftRecipientId || !promo.giftRecipientEmail) {
      throw Object.assign(new Error('Verify the recipient email before continuing to payment.'), { status: 409 });
    }
    return { recipientUserId: promo.giftRecipientId, recipientEmail: promo.giftRecipientEmail };
  }
  const normalizedEmail = String(recipientEmail || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw Object.assign(new Error('Enter the registered email address of the gift recipient.'), { status: 400 });
  }
  if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw Object.assign(new Error('Enter a valid recipient email address.'), { status: 400 });
  }
  const recipient = await User.findOne({ email: normalizedEmail }).select('googleId email').session(session).lean();
  if (!recipient) {
    throw Object.assign(new Error('The recipient email must belong to a registered Innovation Labs account.'), { status: 404 });
  }
  if (recipient.googleId === userId) {
    throw Object.assign(new Error('Choose a different registered Innovation Labs account for an offline gift.'), { status: 400 });
  }
  return { recipientUserId: recipient.googleId, recipientEmail: recipient.email };
};

const aiPlanEntitlements = {
  Starter: { buildLimit: 2, addComponents: false, checkoutAssistance: false },
  Medium: { buildLimit: 2, addComponents: false, checkoutAssistance: false },
  Premium: { buildLimit: 4, addComponents: true, checkoutAssistance: false },
  Exclusive: { buildLimit: null, addComponents: true, checkoutAssistance: true },
};

const planFeatures = [
  ['Normal website, product browsing, cart and checkout', ['Starter', 'Medium', 'Premium', 'Exclusive']],
  ['Razorpay and wallet payments', ['Starter', 'Medium', 'Premium', 'Exclusive']],
  ['Promo-code wallet system and order tracking', ['Starter', 'Medium', 'Premium', 'Exclusive']],
  ['Priority customer support', ['Medium', 'Premium', 'Exclusive']],
  ['Priority delivery where supported', ['Medium', 'Premium', 'Exclusive']],
  ['Additional account features', ['Medium', 'Premium', 'Exclusive']],
  ['AI Project Builder', ['Starter', 'Medium', 'Premium', 'Exclusive'], { Starter: 'Two builds', Medium: 'Two builds', Premium: 'Four builds*', Exclusive: 'Unlimited' }],
  ['AI-assisted cart addition', ['Premium', 'Exclusive'], { Starter: 'No', Medium: 'No', Premium: 'Yes', Exclusive: 'Yes' }],
  ['AI-assisted checkout assistance', ['Exclusive'], { Starter: 'No', Medium: 'No', Premium: 'No', Exclusive: 'Yes · confirmation required' }],
  ['Trial cashback', [], { Starter: 'No', Medium: 'No', Premium: 'No', Exclusive: 'No' }],
  ['AI shopping assistant and product search', []],
  ['AI product identification and specifications', []],
  ['AI screen commands and website navigation', []],
  ['AI credits', []],
  ['AI credits included each month', []],
  ['One-time wallet cashback on activation', ['Premium', 'Exclusive']],
  ['AI purchase with explicit final confirmation', []],
  ['Additional advanced AI and account assistance', []],
];

const getPlanSummary = () => Object.entries(planConfig).map(([name, config]) => ({
  name,
  price: money(config.pricePaise),
  credits: config.credits,
  cashback: money(config.cashbackPaise),
  features: planFeatures.map(([label, included, values]) => ({ label, included: included.includes(name), value: values?.[name] || null })),
}));

const addOneMonth = (date) => {
  const next = new Date(date);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
};

const renewDueSubscriptions = async (userId) => {
  if (mongoose.connection.readyState !== 1) return;
  const dueSubscriptions = await Subscription.find({ userId, status: 'active', autoRenew: true, expiryDate: { $lte: new Date() } }).lean();
  for (const due of dueSubscriptions) {
    await withMongoTransaction(async (session) => {
      const subscription = await Subscription.findOne({ _id: due._id, status: 'active', autoRenew: true, expiryDate: { $lte: new Date() } }).session(session);
      if (!subscription) return;
      const config = planConfig[subscription.plan];
      const paymentReference = `renewal:${subscription._id}:${subscription.expiryDate.getTime()}`;
      const wallet = await Wallet.findOne({ userId }).session(session);
      if (!wallet || wallet.balancePaise < config.pricePaise) {
        subscription.status = 'renewal_failed';
        subscription.renewalHistory.push({ date: new Date(), status: 'Failed', paymentReference, amountPaise: config.pricePaise });
        await subscription.save({ session });
        await Notification.create([{
          userId,
          message: `${subscription.plan} could not renew because your wallet balance was insufficient. Your plan has expired; choose a plan to continue.`,
        }], { session });
        return;
      }

      const now = new Date();
      const before = wallet.balancePaise;
      wallet.balancePaise -= config.pricePaise;
      await wallet.save({ session });
      await WalletTransaction.create([{
        userId,
        type: 'Purchase',
        amountPaise: -config.pricePaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: paymentReference,
        description: `${subscription.plan} automatic renewal`,
        status: 'Successful',
      }], { session });
      subscription.expiryDate = addOneMonth(now);
      subscription.paymentMethod = 'Wallet';
      subscription.paymentReference = paymentReference;
      subscription.renewalHistory.push({ date: now, status: 'Successful', paymentReference, amountPaise: config.pricePaise });
      await subscription.save({ session });
      await SubscriptionTransaction.create([{
        userId,
        plan: subscription.plan,
        amountPaise: config.pricePaise,
        paymentMethod: 'Wallet',
        paymentReference,
        cashbackPaise: 0,
        status: 'Successful',
      }], { session });
      if (config.credits > 0) {
        const credits = await AICredits.findOneAndUpdate(
          { userId },
          { $inc: { balance: config.credits, includedCredits: config.credits } },
          { new: true, upsert: true, setDefaultsOnInsert: true, session },
        );
        await AICreditTransaction.create([{
          userId,
          type: 'added',
          amount: config.credits,
          action: `${subscription.plan} monthly renewal credits`,
          reference: `subscription-credits:${paymentReference}`,
          balanceAfter: credits.balance,
        }], { session });
      }
    });
  }
};

const currentSubscription = async (userId, session) => {
  const now = new Date();
  if (!session) await renewDueSubscriptions(userId);
  await Subscription.updateMany({ userId, status: 'active', expiryDate: { $lte: now } }, { $set: { status: 'expired' } }, { session });
  return Subscription.findOne({ userId, status: 'active', expiryDate: { $gt: now } }).sort({ expiryDate: -1 }).session(session || null).lean();
};

const requireActiveExclusiveCreditAccess = async (req, res, next) => {
  const subscription = await currentSubscription(req.session.sub);
  if (subscription?.plan !== 'Exclusive') {
    return res.status(403).json({ message: 'Add Credits is available to active Exclusive subscribers only.' });
  }
  return next();
};

const requireExclusiveCreditAccess = async (req, res, next) => {
  const subscription = await currentSubscription(req.session.sub);
  if (subscription?.plan === 'Exclusive') return next();
  const purchaseId = req.params.purchaseId || req.body?.purchaseId;
  const pendingPurchase = purchaseId && await CreditPurchase.exists({
    purchaseId,
    userId: req.session.sub,
    authorizedPlan: 'Exclusive',
    status: { $in: ['pending', 'processing', 'completed'] },
  });
  if (pendingPurchase) return next();
  return res.status(403).json({ message: 'Add Credits is available to active Exclusive subscribers only.' });
};

const aiTrialView = (trial, now = new Date()) => ({
  used: Boolean(trial),
  active: Boolean(trial && trial.status === 'active' && trial.expiresAt > now),
  plan: trial?.plan || null,
  activatedAt: trial?.activatedAt || null,
  expiresAt: trial?.expiresAt || null,
  expirationWarningShownAt: trial?.expirationWarningShownAt || null,
  remainingBuilds: trial ? Math.max(0, trial.buildLimit - trial.successfulBuilds) : null,
  buildLimit: trial?.buildLimit ?? 2,
});

const getAiAccess = async (userId) => {
  const now = new Date();
  const [subscription, trial] = await Promise.all([
    currentSubscription(userId),
    AITrial.findOne({ userId }).lean(),
  ]);
  const activeTrial = trial?.status === 'active' && trial.expiresAt > now ? trial : null;
  if (trial?.status === 'active' && trial.expiresAt <= now) {
    await AITrial.updateOne({ _id: trial._id, status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
  }
  const plan = subscription?.plan || activeTrial?.plan || 'Starter';
  const planEntitlement = aiPlanEntitlements[plan] || aiPlanEntitlements.Starter;
  const trialMode = Boolean(activeTrial && !subscription);
  const buildLimit = trialMode ? activeTrial.buildLimit : planEntitlement.buildLimit;
  const quotaKey = trialMode
    ? `trial:${activeTrial._id}`
    : plan === 'Starter'
      ? `starter:${userId}`
      : `subscription:${subscription?._id || plan}`;
  const quota = await AIProjectQuota.findOne({ userId, quotaKey }).lean();
  const buildsUsed = (quota?.successfulBuilds || 0) + (quota?.pendingBuilds || 0);
  const trialView = aiTrialView(trial, now);
  if (activeTrial) trialView.remainingBuilds = Math.max(0, activeTrial.buildLimit - buildsUsed);
  return {
    plan,
    accessType: trialMode ? 'trial' : subscription ? 'paid' : 'starter',
    subscription,
    trialRecord: activeTrial,
    trial: trialView,
    trialMode,
    quotaKey,
    buildLimit,
    buildsUsed,
    remainingBuilds: buildLimit == null ? null : Math.max(0, buildLimit - buildsUsed),
    canBuildProjects: true,
    canAddComponents: trialMode ? ['Premium', 'Exclusive'].includes(plan) : planEntitlement.addComponents,
    canAssistCheckout: trialMode ? plan === 'Exclusive' : planEntitlement.checkoutAssistance,
    trialEligible: !subscription && !trial,
  };
};

const aiAccessResponse = (access) => ({
  plan: access.plan,
  accessType: access.accessType,
  entitlements: {
    projectBuilder: true,
    buildLimit: access.buildLimit,
    buildsUsed: access.buildsUsed,
    remainingBuilds: access.remainingBuilds,
    addComponents: access.canAddComponents,
    checkoutAssistance: access.canAssistCheckout,
    trialCashback: false,
  },
  trial: { ...access.trial, eligible: access.trialEligible },
  subscription: access.subscription ? {
    plan: access.subscription.plan,
    startDate: access.subscription.startDate,
    expiryDate: access.subscription.expiryDate,
    status: access.subscription.status,
  } : null,
});

const processAllDueRenewals = async () => {
  if (mongoose.connection.readyState !== 1) return;
  const dueUsers = await Subscription.distinct('userId', { status: 'active', autoRenew: true, expiryDate: { $lte: new Date() } });
  await Promise.all(dueUsers.map((userId) => renewDueSubscriptions(userId)));
};

const getOrderLimit = async () => {
  const setting = await AdminSetting.findOne({ key: 'max_active_orders' }).lean();
  return Number(setting?.value ?? 50);
};

const enforceOrderLimit = async (session) => {
  const maxActive = await getOrderLimit();
  const countQuery = Order.countDocuments({
    orderStatus: { $in: ['Processing', 'Pending Review', 'Accepted', 'Ordered'] },
  });
  const activeCount = session ? await countQuery.session(session) : await countQuery;
  if (activeCount >= maxActive) {
    throw Object.assign(new Error('Orders Temporarily Full. We have currently reached our order capacity. Please try again later.'), { status: 409 });
  }
};

const applyInventoryReduction = async (session, items) => {
  const inventoryDeductedAt = new Date();
  for (const item of items || []) {
    if (item.customOrderId || item.discountOfferId) continue;
    const remainingStock = { $subtract: ['$stock', item.quantity] };
    const inventory = await InventoryItem.findOneAndUpdate(
      { productId: item.id, stock: { $gte: item.quantity } },
      [{ $set: {
        stock: remainingStock,
        status: { $cond: [{ $gt: [remainingStock, 5] }, 'In Stock', { $cond: [{ $gt: [remainingStock, 0] }, 'Low Stock', 'Out of Stock'] }] },
        updatedAt: inventoryDeductedAt,
      } }],
      { session, returnDocument: 'after', updatePipeline: true },
    ).lean();
    if (!inventory) {
      throw Object.assign(new Error(`Sorry, ${item.name} is no longer available in the requested quantity.`), { status: 409 });
    }
  }
  return inventoryDeductedAt;
};

const refundRazorpayPayment = async (paymentId, expectedAmountPaise) => {
  if (!razorpayKeyId || !razorpayKeySecret) throw new Error('Razorpay refund credentials are not configured.');
  const authorization = `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`;
  const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authorization },
  });
  const payment = await paymentResponse.json();
  if (!paymentResponse.ok || payment.amount !== expectedAmountPaise || payment.currency !== 'INR' || !['captured', 'partially_refunded', 'refunded'].includes(payment.status)) {
    throw new Error('The captured payment could not be verified for an automatic refund.');
  }
  const refundAmount = expectedAmountPaise - Number(payment.amount_refunded || 0);
  if (refundAmount <= 0) return { alreadyRefunded: true };
  const refundResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: refundAmount, notes: { reason: 'Inventory unavailable at order confirmation.' } }),
  });
  const refund = await refundResponse.json();
  if (!refundResponse.ok) throw new Error('Razorpay could not process the automatic refund.');
  return { alreadyRefunded: false, refundId: refund.id };
};

const restoreInventoryForOrder = async (session, order) => {
  if (!order.inventoryDeductedAt && !order.acceptedAt && order.orderStatus !== 'Accepted') return;
  for (const item of order.items || []) {
    if (item.customOrderId) continue;
    const restoredStock = { $add: ['$stock', item.quantity] };
    await InventoryItem.updateOne(
      { productId: item.id },
      [{ $set: {
        stock: restoredStock,
        status: { $cond: [{ $gt: [restoredStock, 5] }, 'In Stock', { $cond: [{ $gt: [restoredStock, 0] }, 'Low Stock', 'Out of Stock'] }] },
        updatedAt: new Date(),
      } }],
      { session, updatePipeline: true },
    );
  }
  order.inventoryDeductedAt = null;
};

const activateSubscription = async (session, { userId, plan, paymentMethod, paymentReference }) => {
  if (await currentSubscription(userId, session)) {
    throw Object.assign(new Error('Your current plan remains active until it expires.'), { status: 409 });
  }
  const config = planConfig[plan];
  if (!config || plan === 'Starter') throw Object.assign(new Error('Choose a paid plan.'), { status: 400 });
  const now = new Date();
  const expiryDate = addOneMonth(now);
  const subscription = await Subscription.create([{
    userId,
    plan,
    pricePaise: config.pricePaise,
    startDate: now,
    expiryDate,
    autoRenew: true,
    status: 'active',
    paymentMethod,
    paymentReference,
    cashbackGranted: config.cashbackPaise > 0,
  }], { session });
  const cashbackPaise = config.cashbackPaise;
  if (cashbackPaise > 0) {
    const wallet = await Wallet.findOneAndUpdate(
      { userId },
      { $inc: { balancePaise: cashbackPaise }, $setOnInsert: { pinHash: '' } },
      { new: true, upsert: true, setDefaultsOnInsert: true, session },
    );
    if (wallet) {
      const before = wallet.balancePaise - cashbackPaise;
      await WalletTransaction.create([{
        userId,
        type: 'Adjustment',
        amountPaise: cashbackPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: `subscription-cashback:${paymentReference}`,
        description: `${plan} activation cashback`,
        status: 'Successful',
      }], { session });
    }
  }
  if (config.credits > 0) {
    const credits = await AICredits.findOneAndUpdate(
      { userId },
      { $inc: { balance: config.credits, includedCredits: config.credits } },
      { new: true, upsert: true, setDefaultsOnInsert: true, session },
    );
    await AICreditTransaction.create([{
      userId,
      type: 'added',
      amount: config.credits,
      action: `${plan} monthly credits`,
      reference: `subscription-credits:${paymentReference}`,
      balanceAfter: credits.balance,
    }], { session });
  }
  await SubscriptionTransaction.create([{
    userId,
    plan,
    amountPaise: config.pricePaise,
    paymentMethod,
    paymentReference,
    cashbackPaise,
    status: 'Successful',
  }], { session });
  await Notification.create([{
    userId,
    message: `${plan} plan activated.${cashbackPaise ? ` ₹${money(cashbackPaise)} activation cashback added.` : ''}${config.credits ? ` ${config.credits.toLocaleString('en-IN')} AI credits added.` : ''}`,
  }], { session });
  await createInvoiceForStandalonePurchase(session, {
    userId,
    orderId: `SUB-${paymentReference}`,
    paymentId: paymentReference,
    paymentMethod,
    itemName: `${plan} Membership Plan`,
    amountPaise: config.pricePaise,
  });
  return subscription[0].toObject();
};

const planPaymentResponse = (subscription) => ({
  subscription: {
    id: String(subscription._id),
    plan: subscription.plan,
    price: money(subscription.pricePaise),
    startDate: subscription.startDate,
    expiryDate: subscription.expiryDate,
    autoRenew: subscription.autoRenew,
    status: subscription.status,
    paymentMethod: subscription.paymentMethod,
    cashbackGranted: subscription.cashbackGranted,
  },
  cashback: money(planConfig[subscription.plan].cashbackPaise),
  credits: planConfig[subscription.plan].credits,
});

app.get('/api/auth/me', requireSession, requireDatabase, async (req, res) => {
  const user = await User.findOne({ googleId: req.session.sub }).lean();
  if (!user) return res.sendStatus(401);
  return res.json({ user: {
    id: user.googleId,
    name: user.name,
    email: user.email,
    picture: user.picture || null,
    isAdmin: req.session.admin === true && isAdminEmail(user.email),
  }, requiresAdminVerification: isAdminEmail(user.email) && req.session.admin !== true });
});

app.post('/api/auth/google', async (req, res) => {
  if (!googleClientId || !sessionSecret) {
    return res.status(503).json({ message: 'Google sign-in is not configured on the server.' });
  }
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Google sign-in is unavailable until the database connection is restored.' });
  }

  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ message: 'Google credential is required.' });

  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      return res.status(401).json({ message: 'Google account could not be verified.' });
    }

    const user = {
      id: payload.sub,
      name: payload.name || payload.email.split('@')[0],
      email: payload.email,
      picture: payload.picture || null,
      isAdmin: false,
    };
    await User.findOneAndUpdate(
      { googleId: user.id },
      { googleId: user.id, name: user.name, email: user.email, picture: user.picture },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    createSessionCookie(res, { sub: user.id, email: user.email, name: user.name });
    return res.json({ user, requiresAdminVerification: isAdminEmail(user.email) });
  } catch (error) {
    console.error('Google token verification failed:', error.message);
    return res.status(401).json({ message: 'Google sign-in failed. Please try again.' });
  }
});

app.post('/api/auth/admin/verify', requireSession, (req, res) => {
  const email = String(req.session.email || '').trim().toLowerCase();
  if (!isAdminEmail(email)) return res.status(403).json({ message: 'Admin verification is unavailable for this account.' });
  if (!adminPassword) return res.status(503).json({ message: 'Admin verification is not configured on the server.' });

  const key = String(req.session.sub || email);
  const attempt = adminVerificationAttempts.get(key) || { count: 0, lockedUntil: 0 };
  if (attempt.lockedUntil > Date.now()) return res.status(429).json({ message: 'Too many attempts. Please try again later.' });

  const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
  const digest = (value) => crypto.createHmac('sha256', sessionSecret || 'admin-verification').update(value).digest();
  const passwordMatches = crypto.timingSafeEqual(digest(suppliedPassword), digest(adminPassword));
  if (!passwordMatches) {
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.count = 0;
      attempt.lockedUntil = Date.now() + 10 * 60 * 1000;
    }
    adminVerificationAttempts.set(key, attempt);
    return res.status(401).json({ message: 'The admin password you entered is incorrect.' });
  }

  adminVerificationAttempts.delete(key);
  createSessionCookie(res, { sub: req.session.sub, email: req.session.email, name: req.session.name, admin: true });
  return res.json({ user: { id: req.session.sub, name: req.session.name, email: req.session.email, isAdmin: true } });
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const session = jwt.verify(req.cookies.innovation_session || '', sessionSecret);
    if (session.jti) {
      revokedSessionIds.add(session.jti);
      if (mongoose.connection.readyState === 1 && session.exp) {
        await RevokedSession.updateOne(
          { sessionId: session.jti },
          { $setOnInsert: { sessionId: session.jti, expiresAt: new Date(session.exp * 1000) } },
          { upsert: true },
        );
      }
    }
  } catch {
    // Clearing a missing or expired session remains a successful logout.
  }
  res.clearCookie('innovation_session');
  res.clearCookie(walletUnlockCookieName, { path: '/api' });
  res.sendStatus(204);
});

app.get('/api/health/database', async (_req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ database: 'disconnected', errorType: databaseDiagnostic.errorType || 'unavailable' });
  }
  try {
    await mongoose.connection.db.command({ ping: 1 });
    return res.json({ database: 'connected', databaseName: mongoose.connection.name || 'configured database' });
  } catch (error) {
    databaseDiagnostic = { state: 'disconnected', errorType: classifyDatabaseError(error) };
    return res.status(503).json({ database: 'disconnected', errorType: databaseDiagnostic.errorType });
  }
});

app.get('/api/health/payment', (_req, res) => {
  return res.json({
    razorpay: razorpayKeyId && razorpayKeySecret ? 'configured' : 'not_configured',
    serverKeyIdPresent: Boolean(razorpayKeyId),
    serverSecretPresent: Boolean(razorpayKeySecret),
  });
});

app.get('/api/plans', (_req, res) => res.json({ plans: getPlanSummary() }));

const notifyBackInStockSubscribers = async (productId, productName) => {
  await withMongoTransaction(async (session) => {
    const subscribers = await BackInStockSubscription.find({ productId, notifiedAt: { $exists: false } }).session(session).lean();
    if (!subscribers.length) return;
    const notifications = [];
    for (const subscriber of subscribers) {
      const claimed = await BackInStockSubscription.findOneAndUpdate(
        { _id: subscriber._id, notifiedAt: { $exists: false } },
        { $set: { notifiedAt: new Date() } },
        { new: true, session },
      ).select('_id').lean();
      if (claimed) notifications.push({
        userId: subscriber.userId,
        type: 'back_in_stock',
        data: { productId },
        message: `${productName} is back in stock.`,
      });
    }
    if (notifications.length) await Notification.create(notifications, { session });
  });
};

app.get('/api/products', requireDatabase, async (_req, res) => {
  const inventory = await InventoryItem.find().sort({ category: 1, name: 1 }).lean();
  const products = inventory.map((item) => ({
    id: item.productId,
    name: item.name,
    category: item.category || 'Other Components',
    price: money(item.pricePaise),
    description: item.description || `${item.name} for electronics and custom projects.`,
    stock: item.stock,
    status: item.status,
    inventoryProduct: true,
    images: Array.isArray(item.images) ? item.images : [],
    technicalSpecs: item.technicalSpecs || {},
  }));
  return res.json({ products });
});

const getProductById = async (productId) => {
  const inventoryItem = await InventoryItem.findOne({ productId }).lean();
  if (!inventoryItem) return null;
  return {
    id: productId,
    name: inventoryItem.name,
    category: inventoryItem.category || 'Other Components',
    price: money(inventoryItem.pricePaise),
    description: inventoryItem.description || `${inventoryItem.name} for Arduino prototypes, robotics, and hands-on electronics projects.`,
    stock: inventoryItem.stock,
    status: inventoryItem.status,
    inventoryProduct: true,
    images: (inventoryItem.images || []).filter((image) => typeof image === 'string'),
    technicalSpecs: inventoryItem?.technicalSpecs && typeof inventoryItem.technicalSpecs === 'object' ? inventoryItem.technicalSpecs : {},
  };
};

const browsingHistoryProductView = async (records) => {
  const productIds = [...new Set(records.map((record) => record.productId))];
  const inventory = await InventoryItem.find({ productId: { $in: productIds } }).lean();
  const inventoryById = new Map(inventory.map((item) => [item.productId, item]));
  return records.map((record) => {
    const item = inventoryById.get(record.productId);
    const available = Boolean(item);
    return {
      productId: record.productId,
      viewedAt: record.viewedAt,
      product: {
        id: record.productId,
        name: item?.name || record.productName,
        category: item?.category || 'Unavailable',
        price: item ? money(item.pricePaise) : null,
        description: item?.description || (available
          ? `${item.name} for electronics and hands-on projects.`
          : 'This product is no longer available.'),
        stock: item?.stock ?? null,
        status: item?.status || (available ? 'In Stock' : 'Unavailable'),
        inventoryProduct: Boolean(item),
        images: Array.isArray(item?.images) ? item.images : [],
        available,
      },
    };
  });
};

app.get('/api/browsing-history', requireSession, requireDatabase, async (req, res) => {
  try {
    const records = await ProductBrowsingHistory.find({ userId: req.session.sub })
      .sort({ viewedAt: -1 })
      .limit(1000)
      .lean();
    return res.json({ history: await browsingHistoryProductView(records) });
  } catch (error) {
    console.error('Could not load product browsing history:', error.message);
    return res.status(500).json({ message: 'Product browsing history could not be loaded.' });
  }
});

app.post('/api/browsing-history', requireSession, requireDatabase, async (req, res) => {
  const productId = typeof req.body?.productId === 'string' ? req.body.productId.trim() : '';
  if (!productId || productId.length > 120) return res.status(400).json({ message: 'A valid product ID is required.' });

  try {
    const product = await getProductById(productId);
    if (!product) return res.status(404).json({ message: 'Product was not found.' });
    await ProductBrowsingHistory.findOneAndUpdate(
      { userId: req.session.sub, productId },
      { $set: { productName: product.name, viewedAt: new Date() } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    return res.json({ success: true });
  } catch (error) {
    if (error.code === 11000) {
      try {
        await ProductBrowsingHistory.updateOne(
          { userId: req.session.sub, productId },
          { $set: { productName: (await getProductById(productId)).name, viewedAt: new Date() } },
        );
        return res.json({ success: true });
      } catch (retryError) {
        console.error('Could not record product browsing history:', retryError.message);
        return res.status(500).json({ message: 'Product view could not be recorded.' });
      }
    }
    console.error('Could not record product browsing history:', error.message);
    return res.status(500).json({ message: 'Product view could not be recorded.' });
  }
});

app.post('/api/browsing-history/sync', requireSession, requireDatabase, async (req, res) => {
  const incoming = Array.isArray(req.body?.items) ? req.body.items.slice(0, 1000) : null;
  if (!incoming) return res.status(400).json({ message: 'A browsing history list is required.' });

  const parsed = new Map();
  for (const entry of incoming) {
    const productId = typeof entry?.productId === 'string' ? entry.productId.trim() : '';
    const viewedAt = new Date(entry?.viewedAt);
    if (!productId || productId.length > 120 || Number.isNaN(viewedAt.getTime()) || viewedAt > new Date()) continue;
    const existing = parsed.get(productId);
    if (!existing || viewedAt > existing.viewedAt) parsed.set(productId, { productId, viewedAt });
  }

  try {
    const productIds = [...parsed.keys()];
    const inventory = await InventoryItem.find({ productId: { $in: productIds } }).select('productId name').lean();
    const inventoryById = new Map(inventory.map((item) => [item.productId, item]));
    const operations = [];
    for (const entry of parsed.values()) {
      const item = inventoryById.get(entry.productId);
      const productName = item?.name;
      if (!productName) continue;
      operations.push({
        updateOne: {
          filter: { userId: req.session.sub, productId: entry.productId },
          update: {
            $set: { productName },
            $max: { viewedAt: entry.viewedAt },
            $setOnInsert: { userId: req.session.sub, productId: entry.productId },
          },
          upsert: true,
        },
      });
    }
    if (operations.length) await ProductBrowsingHistory.bulkWrite(operations, { ordered: false });
    return res.json({ synchronized: operations.length });
  } catch (error) {
    console.error('Could not synchronize product browsing history:', error.message);
    return res.status(500).json({ message: 'Guest browsing history could not be synchronized.' });
  }
});

app.delete('/api/browsing-history/:productId', requireSession, requireDatabase, async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  if (!productId || productId.length > 120) return res.status(400).json({ message: 'A valid product ID is required.' });
  try {
    await ProductBrowsingHistory.deleteOne({ userId: req.session.sub, productId });
    return res.json({ success: true });
  } catch (error) {
    console.error('Could not remove product browsing history item:', error.message);
    return res.status(500).json({ message: 'Product view could not be removed from history.' });
  }
});

app.delete('/api/browsing-history', requireSession, requireDatabase, async (req, res) => {
  try {
    await ProductBrowsingHistory.deleteMany({ userId: req.session.sub });
    return res.json({ success: true });
  } catch (error) {
    console.error('Could not clear product browsing history:', error.message);
    return res.status(500).json({ message: 'Product browsing history could not be cleared.' });
  }
});

const reviewImageType = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
};

const publicReviewView = (review) => ({
  reviewId: review.reviewId,
  customerName: review.customerName,
  rating: review.rating,
  description: review.description,
  verifiedPurchase: review.verifiedPurchase,
  createdAt: review.createdAt,
  images: (review.images || []).map((_image, index) => `/api/product-reviews/${encodeURIComponent(review.reviewId)}/images/${index}`),
});

app.get('/api/products/:productId', requireDatabase, async (req, res) => {
  const product = await getProductById(req.params.productId);
  if (!product) return res.status(404).json({ message: 'Product was not found.' });
  const rewardRules = await rewardRulesFor(null);
  const rewardEligible = !/plan|membership|subscription|service|delivery|ai credit/i.test(`${product.category || ''} ${product.name || ''}`);
  const rewardPoints = rewardEligible ? pointsForEligibleAmount(toPaise(product.price), rewardRules) : 0;
  const reviews = await ProductReview.find({ productId: product.id, moderationStatus: 'approved' })
    .sort({ createdAt: -1 })
    .select('-images.data')
    .lean();
  const distribution = [5, 4, 3, 2, 1].map((rating) => {
    const count = reviews.filter((review) => review.rating === rating).length;
    return { rating, count, percentage: reviews.length ? Math.round(count * 100 / reviews.length) : 0 };
  });
  const averageRating = reviews.length
    ? Math.round(reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length * 10) / 10
    : 0;
  return res.json({ product, rewardPoints, reviews: reviews.map(publicReviewView), reviewSummary: { averageRating, totalReviews: reviews.length, distribution } });
});

app.get('/api/products/:productId/review-eligibility', requireSession, requireDatabase, async (req, res) => {
  const product = await getProductById(req.params.productId);
  if (!product) return res.status(404).json({ message: 'Product was not found.' });
  const existingReview = await ProductReview.exists({ userId: req.session.sub, productId: product.id });
  if (existingReview) return res.json({ eligible: false, alreadyReviewed: true, message: 'You have already submitted a review for this product.' });
  const order = await Order.findOne({
    userId: req.session.sub,
    paymentStatus: 'Paid',
    orderStatus: { $nin: ['Cancelled', 'Declined', 'Rejected'] },
    items: { $elemMatch: { id: product.id, customOrderId: { $exists: false }, discountOfferId: { $exists: false } } },
  }).sort({ createdAt: -1 }).select('orderId').lean();
  return res.json(order
    ? { eligible: true, orderId: order.orderId }
    : { eligible: false, alreadyReviewed: false, message: 'You can only review products that you have purchased from Innovation Labs.' });
});

const reviewImageUpload = (req, res, next) => uploadReviewImages.array('images', 5)(req, res, (error) => {
  if (error) return res.status(400).json({ message: error.message || 'Review images could not be uploaded.' });
  return next();
});

app.post('/api/products/:productId/reviews', requireSession, requireDatabase, reviewImageUpload, async (req, res) => {
  const product = await getProductById(req.params.productId);
  if (!product) return res.status(404).json({ message: 'Product was not found.' });
  const rating = Number(req.body?.rating);
  const description = String(req.body?.description || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: 'Choose a star rating from 1 to 5.' });
  if (description.length > 2000) return res.status(400).json({ message: 'Review text must be 2,000 characters or fewer.' });
  const files = req.files || [];
  if (files.some((file) => !reviewImageType(file.buffer))) return res.status(400).json({ message: 'One or more uploaded files are not valid JPEG, PNG, or WebP images.' });
  try {
    const result = await withMongoTransaction(async (session) => {
      const existingReview = await ProductReview.exists({ userId: req.session.sub, productId: product.id }).session(session);
      if (existingReview) throw Object.assign(new Error('You have already submitted a review for this product.'), { status: 409 });
      const order = await Order.findOne({
        userId: req.session.sub,
        paymentStatus: 'Paid',
        orderStatus: { $nin: ['Cancelled', 'Declined', 'Rejected'] },
        items: { $elemMatch: { id: product.id, customOrderId: { $exists: false }, discountOfferId: { $exists: false } } },
      }).sort({ createdAt: -1 }).session(session).lean();
      if (!order) throw Object.assign(new Error('You can only review products that you have purchased from Innovation Labs.'), { status: 403 });
      const user = await User.findOne({ googleId: req.session.sub }).select('name').session(session).lean();
      const [review] = await ProductReview.create([{
        reviewId: `REV-${crypto.randomUUID()}`,
        userId: req.session.sub,
        customerName: user?.name || req.session.name || 'Innovation Labs customer',
        productId: product.id,
        productName: product.name,
        orderId: order.orderId,
        rating,
        description,
        images: files.map((file) => ({
          data: file.buffer,
          contentType: reviewImageType(file.buffer),
          originalName: String(file.originalname || 'review-image').replace(/[\\/"\r\n]/g, '').slice(0, 120),
        })),
        verifiedPurchase: true,
        moderationStatus: 'pending',
      }], { session });
      return review;
    });
    return res.status(201).json({ review: { reviewId: result.reviewId, moderationStatus: result.moderationStatus } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'You have already submitted a review for this product.' });
    throw error;
  }
});

app.get('/api/product-reviews/:reviewId/images/:index', async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isSafeInteger(index) || index < 0 || index > 4) return res.sendStatus(404);
  const review = await ProductReview.findOne({ reviewId: req.params.reviewId, moderationStatus: 'approved' }).select('images').lean();
  const image = review?.images?.[index];
  if (!image) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', image.contentType);
  return res.send(image.data);
});

app.get('/api/admin/product-reviews', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const reviews = await ProductReview.find().sort({ createdAt: -1 }).select('-images.data').limit(500).lean();
  return res.json({ reviews: reviews.map((review) => ({
    ...publicReviewView(review),
    productId: review.productId,
    productName: review.productName,
    orderId: review.orderId,
    userId: review.userId,
    moderationStatus: review.moderationStatus,
    images: (review.images || []).map((_image, index) => `/api/admin/product-reviews/${encodeURIComponent(review.reviewId)}/images/${index}`),
  })) });
});

app.get('/api/admin/product-reviews/:reviewId/images/:index', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isSafeInteger(index) || index < 0 || index > 4) return res.sendStatus(404);
  const review = await ProductReview.findOne({ reviewId: req.params.reviewId }).select('images').lean();
  const image = review?.images?.[index];
  if (!image) return res.sendStatus(404);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', image.contentType);
  return res.send(image.data);
});

app.patch('/api/admin/product-reviews/:reviewId/moderation', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const status = req.body?.status;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'Choose approve or reject.' });
  const review = await ProductReview.findOneAndUpdate(
    { reviewId: req.params.reviewId, moderationStatus: 'pending' },
    { $set: { moderationStatus: status, moderatedBy: req.session.email, moderatedAt: new Date() } },
    { new: true },
  ).select('-images.data').lean();
  if (!review) return res.status(404).json({ message: 'Pending product review was not found.' });
  await Notification.create({
    userId: review.userId,
    type: 'product_review_moderation',
    data: { reviewId: review.reviewId, productId: review.productId, status },
    message: status === 'approved'
      ? `Your review for ${review.productName} was approved and is now public.`
      : `Your review for ${review.productName} was not approved.`,
  });
  return res.json({ review: { reviewId: review.reviewId, moderationStatus: review.moderationStatus } });
});

app.post('/api/products/:productId/back-in-stock', requireSession, requireDatabase, async (req, res) => {
  const product = await getProductById(req.params.productId);
  if (!product) return res.status(404).json({ message: 'Product was not found.' });
  if (product.status !== 'Out of Stock' && !(product.inventoryProduct && Number(product.stock) <= 0)) {
    return res.status(409).json({ message: 'This product is currently in stock.' });
  }
  await BackInStockSubscription.updateOne(
    { productId: product.id, userId: req.session.sub },
    { $setOnInsert: { productId: product.id, userId: req.session.sub, email: req.session.email } },
    { upsert: true },
  );
  return res.status(201).json({ subscribed: true, message: 'We will notify you when this product is back in stock.' });
});

const validateWishlistProduct = async (productType, productId) => {
  if (productType === 'product') {
    const inventoryItem = await InventoryItem.findOne({ productId }).lean();
    if (!inventoryItem) throw Object.assign(new Error('This product is not available to save.'), { status: 404 });
    return true;
  }
  if (productType === 'promo' && mongoose.isValidObjectId(productId)) {
    const promo = await PromoCode.findById(productId).select('_id').lean();
    if (promo) return true;
  }
  if (productType === 'discount-code' && mongoose.isValidObjectId(productId)) {
    const offer = await DiscountCodeOffer.findById(productId).select('_id').lean();
    if (offer) return true;
  }
  throw Object.assign(new Error('This wishlist item is not available.'), { status: 404 });
};

const wishlistProductDetails = async (entries) => {
  const productIds = entries.filter((entry) => entry.productType === 'product').map((entry) => entry.productId);
  const promoIds = entries.filter((entry) => entry.productType === 'promo' && mongoose.isValidObjectId(entry.productId)).map((entry) => entry.productId);
  const discountOfferIds = entries.filter((entry) => entry.productType === 'discount-code' && mongoose.isValidObjectId(entry.productId)).map((entry) => entry.productId);
  const [inventory, promos, discountOffers] = await Promise.all([
    productIds.length ? InventoryItem.find({ productId: { $in: productIds } }).lean() : [],
    promoIds.length ? PromoCode.find({ _id: { $in: promoIds } }).select('_id amountPaise status').lean() : [],
    discountOfferIds.length ? DiscountCodeOffer.find({ _id: { $in: discountOfferIds } }).select('_id name sellingPricePaise availableQuantity active startsAt expiresAt discountType discountValuePaise discountPercent').lean() : [],
  ]);
  const inventoryById = new Map(inventory.map((item) => [item.productId, item]));
  const promoById = new Map(promos.map((promo) => [String(promo._id), promo]));
  const discountOfferById = new Map(discountOffers.map((offer) => [String(offer._id), offer]));
  return entries.map((entry) => {
    if (entry.productType === 'promo') {
      const promo = promoById.get(entry.productId);
      return {
        productId: entry.productId,
        productType: 'promo',
        name: 'Digital Wallet Credit',
        category: 'Promo Code',
        price: promo ? money(promo.amountPaise) : 0,
        availability: promo?.status === 'unused' ? 'In Stock' : 'Unavailable',
        addedAt: entry.addedAt,
      };
    }
    if (entry.productType === 'discount-code') {
      const offer = discountOfferById.get(entry.productId);
      const available = offer && offer.active && offer.startsAt <= new Date() && offer.expiresAt > new Date() && offer.availableQuantity > 0;
      return {
        productId: entry.productId,
        productType: 'discount-code',
        name: offer?.name || 'Discount Promo Code',
        category: 'Discount Promo Code',
        price: offer ? money(offer.sellingPricePaise) : 0,
        availability: available ? 'In Stock' : 'Unavailable',
        stock: offer?.availableQuantity ?? 0,
        image: '',
        addedAt: entry.addedAt,
      };
    }
    const inventoryItem = inventoryById.get(entry.productId);
    return {
      productId: entry.productId,
      productType: 'product',
      name: inventoryItem?.name || 'Product no longer available',
      category: inventoryItem?.category || 'Other Components',
      price: inventoryItem ? money(inventoryItem.pricePaise) : 0,
      availability: inventoryItem?.status || 'Unavailable',
      stock: inventoryItem?.stock ?? null,
      inventoryProduct: Boolean(inventoryItem),
      addedAt: entry.addedAt,
    };
  });
};

app.get('/api/wishlist', requireSession, requireDatabase, async (req, res) => {
  const entries = await Wishlist.find({ userId: req.session.sub }).sort({ addedAt: -1 }).lean();
  return res.json({ products: await wishlistProductDetails(entries) });
});

app.post('/api/wishlist/items', requireSession, requireDatabase, async (req, res) => {
  const productType = req.body?.productType;
  const productId = String(req.body?.productId || '').trim();
  if (!['product', 'promo', 'discount-code'].includes(productType) || !productId || productId.length > 120) {
    return res.status(400).json({ message: 'Choose a valid product to add to your wishlist.' });
  }
  await validateWishlistProduct(productType, productId);
  await Wishlist.findOneAndUpdate(
    { userId: req.session.sub, productType, productId },
    { $setOnInsert: { userId: req.session.sub, productType, productId, addedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return res.json({ products: await wishlistProductDetails(await Wishlist.find({ userId: req.session.sub }).sort({ addedAt: -1 }).lean()) });
});

app.delete('/api/wishlist/items/:productType/:productId', requireSession, requireDatabase, async (req, res) => {
  if (!['product', 'promo', 'discount-code'].includes(req.params.productType)) return res.status(400).json({ message: 'Wishlist item type is invalid.' });
  await Wishlist.deleteOne({ userId: req.session.sub, productType: req.params.productType, productId: req.params.productId });
  return res.json({ products: await wishlistProductDetails(await Wishlist.find({ userId: req.session.sub }).sort({ addedAt: -1 }).lean()) });
});

app.post('/api/wishlist/merge', requireSession, requireDatabase, async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products.slice(0, 100) : [];
  for (const entry of products) {
    const productType = entry?.productType;
    const productId = String(entry?.productId || '').trim();
    if (!['product', 'promo', 'discount-code'].includes(productType) || !productId || productId.length > 120) continue;
    try {
      await validateWishlistProduct(productType, productId);
      await Wishlist.findOneAndUpdate(
        { userId: req.session.sub, productType, productId },
        { $setOnInsert: { userId: req.session.sub, productType, productId, addedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error.code !== 11000 && error.status !== 404) throw error;
    }
  }
  return res.json({ products: await wishlistProductDetails(await Wishlist.find({ userId: req.session.sub }).sort({ addedAt: -1 }).lean()) });
});

const discountOfferView = (offer) => ({
  id: String(offer._id),
  name: offer.name,
  source: offer.source || 'ADMIN',
  sellingPrice: money(offer.sellingPricePaise),
  discountType: offer.discountType,
  discountValue: offer.discountType === 'fixed' ? money(offer.discountValuePaise) : offer.discountPercent,
  discountLabel: offer.discountType === 'fixed' ? `₹${money(offer.discountValuePaise)} off` : `${offer.discountPercent}% off`,
  startsAt: offer.startsAt,
  expiresAt: offer.expiresAt,
  minimumPurchase: money(offer.minimumPurchasePaise || 0),
  availableQuantity: offer.availableQuantity,
});

app.get('/api/discount-offers', requireSession, requireDatabase, async (_req, res) => {
  const now = new Date();
  const offers = await DiscountCodeOffer.find({ active: true, startsAt: { $lte: now }, expiresAt: { $gt: now }, availableQuantity: { $gt: 0 } }).sort({ createdAt: -1 }).lean();
  return res.json({ offers: offers.map(discountOfferView) });
});

app.get('/api/discount-codes/mine', requireSession, requireDatabase, async (req, res) => {
  const purchases = await PurchasedDiscountCode.find({ userId: req.session.sub, fulfillmentStatus: 'fulfilled' }).sort({ purchasedAt: -1 }).lean();
  return res.json({ discountCodes: purchases.map((purchase) => ({
    purchaseId: purchase.purchaseId,
    code: purchase.code,
    discountType: purchase.discountType,
    discountValue: purchase.discountType === 'fixed' ? money(purchase.discountValuePaise) : purchase.discountPercent,
    discountLabel: purchase.discountType === 'fixed' ? `₹${money(purchase.discountValuePaise)} off` : `${purchase.discountPercent}% off`,
    minimumPurchase: money(purchase.minimumPurchasePaise || 0),
    expiresAt: purchase.expiresAt,
    redemptionCount: purchase.redemptionCount,
    maxRedemptions: purchase.maxRedemptions,
    status: purchase.expiresAt <= new Date() ? 'expired' : purchase.redemptionCount >= purchase.maxRedemptions ? 'redeemed' : 'available',
    isScratchReward: purchase.isScratchReward,
    orderId: purchase.orderId,
  })) });
});

app.post('/api/discount-codes/validate', requireSession, requireDatabase, async (req, res) => {
  try {
    const { safeItems } = await resolveOrderItems(req.body?.items, req.session.sub);
    const context = await discountCodeContext({ session: null, userId: req.session.sub, code: req.body?.code, items: safeItems });
    return res.json({
      valid: true,
      code: context.code,
      eligibleAmount: money(context.eligibleAmountPaise),
      discountAmount: money(context.discountAmountPaise),
      discountLabel: context.purchase.discountType === 'fixed' ? `₹${money(context.discountAmountPaise)} off` : `${context.purchase.discountPercent}% off`,
      offerName: context.offer?.name || 'Scratch Card Reward',
    });
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message || 'Invalid promo code. Please check your code and try again.', code: error.code || 'DISCOUNT_INVALID' });
  }
});

app.post('/api/discount-offers/:id/purchase-wallet', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Discount offer was not found.' });
  const { pin, idempotencyKey, recipientEmail } = req.body || {};
  if (!validatePin(pin) || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A Wallet PIN and valid purchase reference are required.' });
  try {
    const result = await withMongoTransaction(async (session) => purchaseDiscountOffer(session, {
      offerId: req.params.id,
      userId: req.session.sub,
      userName: req.session.name || req.session.email.split('@')[0],
      userEmail: req.session.email,
      recipientEmail,
      paymentMethod: 'Wallet',
      idempotencyKey,
      pin,
    }));
    return res.status(result.duplicate ? 200 : 201).json({ order: result.order, purchase: result.purchase, wallet: { balance: money(result.wallet?.balancePaise || 0) }, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This discount-code payment has already been processed.' });
    throw error;
  }
});

app.post('/api/discount-offers/:id/razorpay/order', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Discount offer was not found.' });
  const { idempotencyKey, recipientEmail } = req.body || {};
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid purchase reference is required.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for discount-code purchases.' });
  const previous = await DiscountPurchaseIntent.findOne({ userId: req.session.sub, idempotencyKey }).lean();
  if (previous) {
    if (String(previous.offerId) !== req.params.id) return res.status(409).json({ message: 'This purchase reference is already attached to a different discount offer.' });
    return res.json({ orderId: previous.razorpayOrderId, keyId: razorpayKeyId, amountPaise: previous.amountPaise, offerId: String(previous.offerId) });
  }
  const now = new Date();
  const offer = await DiscountCodeOffer.findOne({ _id: req.params.id, active: true, startsAt: { $lte: now }, expiresAt: { $gt: now }, availableQuantity: { $gt: 0 } }).lean();
  if (!offer) return res.status(409).json({ message: 'This discount offer is no longer available.' });
  let recipient;
  try {
    recipient = await resolveDiscountRecipient(null, req.session.sub, req.session.email, recipientEmail);
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message });
  }
  try {
    const providerResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: offer.sellingPricePaise, currency: 'INR', receipt: `discount-${req.session.sub}-${Date.now()}` }),
    });
    const providerOrder = await providerResponse.json();
    if (!providerResponse.ok) return res.status(502).json({ message: 'Razorpay could not create the discount purchase payment.' });
    await DiscountPurchaseIntent.create({ razorpayOrderId: providerOrder.id, userId: req.session.sub, assignedUserId: recipient.userId, recipientEmail: recipient.gift ? recipient.email : undefined, offerId: offer._id, amountPaise: offer.sellingPricePaise, idempotencyKey });
    return res.json({ orderId: providerOrder.id, keyId: razorpayKeyId, amountPaise: offer.sellingPricePaise, offerId: String(offer._id) });
  } catch (error) {
    if (error.code === 11000) {
      const winner = await DiscountPurchaseIntent.findOne({ userId: req.session.sub, idempotencyKey }).lean();
      if (winner && String(winner.offerId) === req.params.id) return res.json({ orderId: winner.razorpayOrderId, keyId: razorpayKeyId, amountPaise: winner.amountPaise, offerId: String(winner.offerId) });
    }
    return res.status(503).json({ message: 'Discount purchase payment is temporarily unavailable.' });
  }
});

app.post('/api/discount-offers/:id/razorpay/verify', requireSession, requireDatabase, async (req, res) => {
  const paymentId = req.body?.razorpay_payment_id;
  const orderId = req.body?.razorpay_order_id;
  const signature = req.body?.razorpay_signature;
  if (!paymentId || !orderId || !signature || !razorpayKeySecret) return res.status(400).json({ message: 'Payment verification details are incomplete.' });
  const expected = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(401).json({ message: 'Discount-code payment verification failed.' });
  const intent = await DiscountPurchaseIntent.findOne({ razorpayOrderId: orderId, userId: req.session.sub, offerId: req.params.id }).lean();
  if (!intent) return res.status(404).json({ message: 'Discount purchase payment was not found.' });
  if (intent.status === 'paid' && intent.orderId) {
    const [order, purchase] = await Promise.all([Order.findOne({ orderId: intent.orderId, userId: req.session.sub }).lean(), PurchasedDiscountCode.findOne({ orderId: intent.orderId }).lean()]);
    return res.json({ order, purchase, duplicate: true });
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay verification is not configured.' });
  try {
    const providerResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` } });
    const payment = await providerResponse.json();
    if (!providerResponse.ok || payment.order_id !== orderId || payment.amount !== intent.amountPaise || payment.currency !== 'INR' || payment.status !== 'captured') return res.status(409).json({ message: 'Payment amount or capture status could not be verified.' });
  } catch {
    return res.status(503).json({ message: 'Razorpay payment verification is temporarily unavailable.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const currentIntent = await DiscountPurchaseIntent.findOne({ _id: intent._id, status: 'pending' }).session(session);
      if (!currentIntent) {
        const previous = await Order.findOne({ razorpayId: paymentId, userId: req.session.sub }).session(session).lean();
        if (previous) return { order: previous, purchase: await PurchasedDiscountCode.findOne({ orderId: previous.orderId }).session(session).lean(), duplicate: true };
        throw Object.assign(new Error('This discount purchase payment has already been processed.'), { status: 409 });
      }
      const offer = await DiscountCodeOffer.findById(currentIntent.offerId).session(session).lean();
      if (!offer) throw Object.assign(new Error('Discount offer was not found.'), { status: 404 });
      const purchased = await purchaseDiscountOffer(session, {
        offerId: String(currentIntent.offerId),
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        recipientEmail: currentIntent.recipientEmail,
        paymentMethod: 'Razorpay',
        paymentId,
        idempotencyKey: currentIntent.idempotencyKey,
      });
      currentIntent.status = 'paid';
      currentIntent.paymentId = paymentId;
      currentIntent.orderId = purchased.order.orderId;
      await currentIntent.save({ session });
      return purchased;
    });
    return res.json({ order: result.order, purchase: result.purchase, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) {
      try {
        await refundRazorpayPayment(paymentId, intent.amountPaise);
        await DiscountPurchaseIntent.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'refunded', paymentId } });
        return res.status(error.status).json({ message: `${error.message} The captured payment was refunded.` });
      } catch (refundError) {
        return res.status(409).json({ message: `${error.message} Automatic refund failed: ${refundError.message}` });
      }
    }
    if (error.code === 11000) return res.status(409).json({ message: 'This discount purchase has already been completed.' });
    throw error;
  }
});

app.post('/api/promotion/claim', requireSession, requireDatabase, async (req, res) => {
  const user = await User.findOne({ googleId: req.session.sub }).select('promoEligibleAt').lean();
  if (!user?.promoEligibleAt || user.promoEligibleAt > new Date()) return res.json({ eligible: false });
  const now = new Date();
  const rollingDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const state = await PromotionState.findOneAndUpdate(
    { userId: req.session.sub },
    { $setOnInsert: { userId: req.session.sub } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const recentShows = state.shownAt.filter((date) => date > rollingDay);
  if (recentShows.length >= 4) return res.json({ eligible: false, nextEligibleAt: new Date(recentShows[0].getTime() + 24 * 60 * 60 * 1000) });
  if (state.lastShownAt && now - state.lastShownAt < 60 * 60 * 1000) {
    return res.json({ eligible: false, nextEligibleAt: new Date(state.lastShownAt.getTime() + 60 * 60 * 1000) });
  }
  state.shownAt = [...recentShows, now];
  state.lastShownAt = now;
  await state.save();
  return res.json({ eligible: true, plan: 'Exclusive' });
});

app.get('/api/subscription', requireSession, requireDatabase, async (req, res) => {
  const [access, history, transactions, credits] = await Promise.all([
    getAiAccess(req.session.sub),
    Subscription.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(20).lean(),
    SubscriptionTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(20).lean(),
    AICredits.findOne({ userId: req.session.sub }).lean(),
  ]);
  const current = access.subscription
    ? planPaymentResponse(access.subscription).subscription
    : access.trial.active
      ? {
        id: `trial:${access.trialRecord._id}`,
        plan: access.trial.plan,
        price: 0,
        startDate: access.trial.activatedAt,
        expiryDate: access.trial.expiresAt,
        autoRenew: false,
        status: 'active',
        paymentMethod: 'Trial',
        cashbackGranted: false,
        isTrial: true,
        buildLimit: access.trial.buildLimit,
        successfulBuilds: access.trial.successfulBuilds,
        remainingBuilds: access.remainingBuilds,
      }
      : { plan: 'Starter', status: 'active', autoRenew: false, isTrial: false };
  return res.json({
    current,
    trial: { ...access.trial, eligible: access.trialEligible },
    history,
    transactions: transactions.map((item) => ({ ...item, amount: money(item.amountPaise), cashback: money(item.cashbackPaise) })),
    credits: credits ? { balance: credits.balance, includedCredits: credits.includedCredits, purchasedCredits: credits.purchasedCredits, usedCredits: credits.usedCredits } : { balance: 0, includedCredits: 0, purchasedCredits: 0, usedCredits: 0 },
  });
});

app.patch('/api/subscription/auto-renew', requireSession, requireDatabase, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ message: 'Choose whether auto-renew is on or off.' });
  const subscription = await currentSubscription(req.session.sub);
  if (!subscription) return res.status(404).json({ message: 'There is no active paid plan to update.' });
  const updated = await Subscription.findOneAndUpdate(
    { _id: subscription._id, status: 'active' },
    { $set: { autoRenew: req.body.enabled } },
    { new: true },
  ).lean();
  return res.json({ subscription: planPaymentResponse(updated).subscription });
});

app.post('/api/subscription/wallet', requireSession, requireDatabase, async (req, res) => {
  const plan = String(req.body?.plan || '');
  const pin = req.body?.pin;
  const idempotencyKey = req.body?.idempotencyKey;
  if (!['Medium', 'Premium', 'Exclusive'].includes(plan)) return res.status(400).json({ message: 'Choose an available paid plan.' });
  if (!validatePin(pin)) return res.status(400).json({ message: 'Enter your 4-digit Wallet PIN in the secure payment field.' });
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid payment reference is required.' });
  const config = planConfig[plan];
  try {
    const result = await withMongoTransaction(async (session) => {
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet || !wallet.pinHash) throw Object.assign(new Error('Set up your Wallet PIN before paying with Wallet.'), { status: 409 });
      if (!verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect PIN. Please try again.'), { status: 401 });
      if (wallet.balancePaise < config.pricePaise) throw Object.assign(new Error('Insufficient wallet balance.'), { status: 402 });
      const paymentReference = `wallet-subscription:${idempotencyKey}`;
      const duplicate = await SubscriptionTransaction.findOne({ userId: req.session.sub, paymentReference }).session(session).lean();
      if (duplicate) {
        const existing = await Subscription.findOne({ userId: req.session.sub, paymentReference }).session(session).lean();
        if (existing) return existing;
        throw Object.assign(new Error('This payment reference has already been used.'), { status: 409 });
      }
      if (await currentSubscription(req.session.sub, session)) throw Object.assign(new Error('Your current plan remains active until it expires.'), { status: 409 });
      const before = wallet.balancePaise;
      wallet.balancePaise -= config.pricePaise;
      await wallet.save({ session });
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Purchase',
        amountPaise: -config.pricePaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: paymentReference,
        description: `${plan} subscription`,
        status: 'Successful',
      }], { session });
      return activateSubscription(session, { userId: req.session.sub, plan, paymentMethod: 'Wallet', paymentReference });
    });
    return res.status(201).json({ ...planPaymentResponse(result), walletBalance: (await Wallet.findOne({ userId: req.session.sub }).select('balancePaise').lean()).balancePaise / 100 });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This subscription payment has already been processed.' });
    throw error;
  }
});

app.post('/api/subscription/razorpay/order', requireSession, requireDatabase, async (req, res) => {
  const plan = String(req.body?.plan || '');
  if (!['Medium', 'Premium', 'Exclusive'].includes(plan)) return res.status(400).json({ message: 'Choose an available paid plan.' });
  if (await currentSubscription(req.session.sub)) return res.status(409).json({ message: 'Your current plan remains active until it expires.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for subscriptions.' });
  const amountPaise = planConfig[plan].pricePaise;
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: `plan-${req.session.sub}-${Date.now()}` }),
    });
    const order = await response.json();
    if (!response.ok) return res.status(502).json({ message: 'Razorpay could not create the subscription payment.' });
    await PlanPayment.create({ orderId: order.id, userId: req.session.sub, plan, amountPaise, status: 'pending' });
    return res.json({ orderId: order.id, keyId: razorpayKeyId, amountPaise, plan });
  } catch {
    return res.status(503).json({ message: 'Subscription payment is temporarily unavailable.' });
  }
});

app.post('/api/subscription/razorpay/verify', requireSession, requireDatabase, async (req, res) => {
  const orderId = req.body?.razorpay_order_id;
  const paymentId = req.body?.razorpay_payment_id;
  const signature = req.body?.razorpay_signature;
  if (typeof orderId !== 'string' || typeof paymentId !== 'string' || typeof signature !== 'string') return res.status(400).json({ message: 'Payment verification details are incomplete.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for subscriptions.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (expectedSignature !== signature) return res.status(401).json({ message: 'Subscription payment verification failed.' });
  const pending = await PlanPayment.findOne({ orderId, userId: req.session.sub }).lean();
  if (!pending) return res.status(404).json({ message: 'Subscription payment was not found.' });
  if (pending.status === 'paid') {
    const existing = await Subscription.findOne({ userId: req.session.sub, paymentReference: paymentId }).lean();
    return existing ? res.json(planPaymentResponse(existing)) : res.status(409).json({ message: 'Subscription payment has already been processed.' });
  }
  try {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
    });
    const payment = await response.json();
    if (!response.ok || payment.amount !== pending.amountPaise || payment.order_id !== orderId || payment.status !== 'captured') return res.status(409).json({ message: 'Payment amount or status could not be verified.' });
  } catch {
    return res.status(503).json({ message: 'Payment verification is temporarily unavailable.' });
  }
  try {
    const subscription = await withMongoTransaction(async (session) => {
      const claimed = await PlanPayment.findOneAndUpdate({ orderId, userId: req.session.sub, status: 'pending' }, { $set: { status: 'paid', paymentId } }, { new: true, session });
      if (!claimed) throw Object.assign(new Error('Subscription payment has already been processed.'), { status: 409 });
      return activateSubscription(session, { userId: req.session.sub, plan: pending.plan, paymentMethod: 'Razorpay', paymentReference: paymentId });
    });
    return res.json(planPaymentResponse(subscription));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This payment has already been applied.' });
    throw error;
  }
});

app.post('/api/credits/purchase', requireSession, requireDatabase, requireActiveExclusiveCreditAccess, async (req, res) => {
  const paymentMethod = req.body?.paymentMethod === 'Razorpay' ? 'Razorpay' : 'Wallet';
  let credits;
  try {
    credits = validateCreditQuantity(req.body?.credits);
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message });
  }
  const idempotencyKey = typeof req.body?.idempotencyKey === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(req.body.idempotencyKey)
    ? req.body.idempotencyKey
    : crypto.randomUUID();
  const existing = await CreditPurchase.findOne({ userId: req.session.sub, idempotencyKey }).lean();
  if (existing) return res.json({ purchase: creditPurchaseView(existing) });
  const purchase = await CreditPurchase.create({
    purchaseId: `CRD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    userId: req.session.sub,
    idempotencyKey,
    credits,
    pricePerCreditPaise: aiCreditPricePaise,
    totalAmountPaise: credits * aiCreditPricePaise,
    paymentMethod,
    authorizedPlan: 'Exclusive',
    status: 'pending',
  });
  return res.status(201).json({ purchase: creditPurchaseView(purchase) });
});

app.get('/api/credits/purchase/:purchaseId', requireSession, requireDatabase, requireExclusiveCreditAccess, async (req, res) => {
  const purchase = await CreditPurchase.findOne({ purchaseId: req.params.purchaseId, userId: req.session.sub }).lean();
  if (!purchase) return res.status(404).json({ message: 'Credit purchase was not found.' });
  const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise').lean();
  const credits = await AICredits.findOne({ userId: req.session.sub }).select('balance').lean();
  return res.json({
    purchase: creditPurchaseView(purchase),
    walletBalance: hasWalletUnlock(req) ? money(wallet?.balancePaise || 0) : null,
    creditBalance: credits?.balance || 0,
  });
});

app.post('/api/credits/wallet/confirm', requireSession, requireDatabase, requireExclusiveCreditAccess, async (req, res) => {
  const { purchaseId, pin } = req.body || {};
  if (typeof purchaseId !== 'string' || !validatePin(pin)) return res.status(400).json({ message: 'Credit purchase and 4-digit Wallet PIN are required.' });
  try {
    const result = await withMongoTransaction(async (session) => {
      const purchase = await CreditPurchase.findOne({ purchaseId, userId: req.session.sub }).session(session);
      if (!purchase) throw Object.assign(new Error('Credit purchase was not found.'), { status: 404 });
      if (purchase.status === 'completed') {
        const balance = await AICredits.findOne({ userId: req.session.sub }).session(session).lean();
        return { purchase, balance: balance?.balance || purchase.newBalance || 0, duplicate: true };
      }
      if (purchase.paymentMethod !== 'Wallet' || !['pending', 'processing'].includes(purchase.status)) throw Object.assign(new Error('This credit purchase is no longer payable.'), { status: 409 });
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet) throw Object.assign(new Error('Create your wallet before purchasing credits.'), { status: 409 });
      if (wallet.lockedUntil && wallet.lockedUntil > new Date()) throw Object.assign(new Error('Wallet PIN is temporarily locked. Please try again later.'), { status: 429 });
      if (!verifyPin(pin, wallet.pinHash)) {
        wallet.failedPinAttempts = (wallet.failedPinAttempts || 0) + 1;
        if (wallet.failedPinAttempts >= 5) {
          wallet.failedPinAttempts = 0;
          wallet.lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
        }
        await wallet.save({ session });
        throw Object.assign(new Error('Incorrect PIN. Payment was not completed.'), { status: 401 });
      }
      if (wallet.balancePaise < purchase.totalAmountPaise) throw Object.assign(new Error(`Insufficient wallet balance. Required: ${money(purchase.totalAmountPaise)}. Available: ${money(wallet.balancePaise)}.`), { status: 402 });
      wallet.failedPinAttempts = 0;
      wallet.lockedUntil = null;
      const before = wallet.balancePaise;
      wallet.balancePaise -= purchase.totalAmountPaise;
      await wallet.save({ session });
      const referenceId = `credit-purchase:${purchase.purchaseId}`;
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Purchase',
        amountPaise: -purchase.totalAmountPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        description: `AI credit purchase ${purchase.purchaseId}`,
        status: 'Successful',
      }], { session });
      const completed = await addPurchasedCredits(session, purchase, `credit:${purchase.purchaseId}`);
      purchase.walletTransactionId = referenceId;
      await purchase.save({ session });
      await Notification.create([{ userId: req.session.sub, message: `${purchase.credits.toLocaleString('en-IN')} AI credits were added to your account.` }], { session });
      return { purchase: completed.purchase, balance: completed.credits.balance, duplicate: false };
    });
    return res.status(result.duplicate ? 200 : 201).json({ purchase: creditPurchaseView(result.purchase), balance: result.balance, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This credit payment is already being processed.' });
    throw error;
  }
});

app.post('/api/credits/razorpay/create', requireSession, requireDatabase, requireExclusiveCreditAccess, async (req, res) => {
  const purchase = await CreditPurchase.findOne({ purchaseId: req.body?.purchaseId, userId: req.session.sub });
  if (!purchase) return res.status(404).json({ message: 'Credit purchase was not found.' });
  if (purchase.status === 'completed') return res.json({ purchase: creditPurchaseView(purchase) });
  if (purchase.paymentMethod !== 'Razorpay') return res.status(409).json({ message: 'This purchase is configured for Wallet payment.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for credit purchases.' });
  if (purchase.razorpayOrderId) return res.json({ purchase: creditPurchaseView(purchase), orderId: purchase.razorpayOrderId, keyId: razorpayKeyId, amountPaise: purchase.totalAmountPaise });
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: purchase.totalAmountPaise, currency: 'INR', receipt: purchase.purchaseId }),
    });
    const order = await response.json();
    if (!response.ok) return res.status(502).json({ message: 'Razorpay could not create the credit payment.' });
    purchase.razorpayOrderId = order.id;
    purchase.status = 'processing';
    await purchase.save();
    return res.json({ purchase: creditPurchaseView(purchase), orderId: order.id, keyId: razorpayKeyId, amountPaise: purchase.totalAmountPaise });
  } catch {
    return res.status(503).json({ message: 'Online credit payment is temporarily unavailable.' });
  }
});

app.post('/api/credits/razorpay/verify', requireSession, requireDatabase, requireExclusiveCreditAccess, async (req, res) => {
  const orderId = req.body?.razorpay_order_id;
  const paymentId = req.body?.razorpay_payment_id;
  const signature = req.body?.razorpay_signature;
  const purchaseId = req.body?.purchaseId;
  if (![orderId, paymentId, signature, purchaseId].every((value) => typeof value === 'string' && value)) return res.status(400).json({ message: 'Credit payment verification details are incomplete.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for credit purchases.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (expectedSignature !== signature) return res.status(401).json({ message: 'Payment verification failed. Please contact support if money was deducted.' });
  const purchase = await CreditPurchase.findOne({ purchaseId, userId: req.session.sub, razorpayOrderId: orderId }).lean();
  if (!purchase) return res.status(404).json({ message: 'Credit purchase was not found.' });
  if (purchase.status === 'completed') return res.json({ purchase: creditPurchaseView(purchase), balance: purchase.newBalance, duplicate: true });
  try {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` } });
    const payment = await response.json();
    if (!response.ok || payment.amount !== purchase.totalAmountPaise || payment.order_id !== orderId || payment.currency !== 'INR' || payment.status !== 'captured') return res.status(409).json({ message: 'Payment amount or status could not be verified.' });
  } catch {
    return res.status(503).json({ message: 'Payment verification is temporarily unavailable.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const current = await CreditPurchase.findOne({ purchaseId, userId: req.session.sub }).session(session);
      if (!current) throw Object.assign(new Error('Credit purchase was not found.'), { status: 404 });
      if (current.status === 'completed') {
        const balance = await AICredits.findOne({ userId: req.session.sub }).session(session).lean();
        return { purchase: current, balance: balance?.balance || current.newBalance || 0, duplicate: true };
      }
      current.razorpayPaymentId = paymentId;
      const completed = await addPurchasedCredits(session, current, `credit:${current.purchaseId}`);
      await Notification.create([{ userId: req.session.sub, message: `${current.credits.toLocaleString('en-IN')} AI credits were added to your account.` }], { session });
      return { purchase: completed.purchase, balance: completed.credits.balance, duplicate: false };
    });
    return res.json({ purchase: creditPurchaseView(result.purchase), balance: result.balance, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This credit payment is already being processed.' });
    throw error;
  }
});

app.get('/api/ai-credits', requireSession, requireDatabase, async (req, res) => {
  const subscription = await currentSubscription(req.session.sub);
  if (!subscription || !['Premium', 'Exclusive'].includes(subscription.plan)) return res.status(403).json({ message: 'AI Credits require an active Premium or Exclusive plan.' });
  const [credits, transactions, purchases] = await Promise.all([
    AICredits.findOne({ userId: req.session.sub }).lean(),
    AICreditTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean(),
    CreditPurchase.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  return res.json({
    plan: subscription.plan,
    balance: credits?.balance || 0,
    transactions,
    purchases: purchases.map(creditPurchaseView),
    pricePerCredit: money(aiCreditPricePaise),
    maxPurchase: aiCreditMaxPurchase,
    costs: aiCreditCosts,
  });
});

app.get('/api/admin/credit-purchases', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const purchases = await CreditPurchase.find().sort({ createdAt: -1 }).limit(500).lean();
  const users = await User.find({ googleId: { $in: purchases.map((purchase) => purchase.userId) } }).select('googleId name email').lean();
  const usersById = new Map(users.map((user) => [user.googleId, user]));
  return res.json({ purchases: purchases.map((purchase) => ({ ...creditPurchaseView(purchase), user: usersById.get(purchase.userId) || { id: purchase.userId } })) });
});

const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
let geminiClient;
const getGeminiClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw Object.assign(new Error('The AI Project Builder is not configured yet. Add GEMINI_API_KEY to the server environment.'), { status: 503, code: 'GEMINI_NOT_CONFIGURED' });
  }
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
};

const aiIdempotencyKey = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
const requestDigest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const forbiddenProjectCode = (value) => /```|#include\b|void\s+setup\s*\(|void\s+loop\s*\(|function\s+setup\s*\(/i.test(value);

app.get('/api/ai/entitlements', requireSession, requireDatabase, async (req, res) => {
  const access = await getAiAccess(req.session.sub);
  return res.json(aiAccessResponse(access));
});

app.get('/api/ai/trial/status', requireSession, requireDatabase, async (req, res) => {
  const access = await getAiAccess(req.session.sub);
  return res.json({ trial: { ...access.trial, eligible: access.trialEligible }, subscription: access.subscription ? {
    plan: access.subscription.plan,
    expiryDate: access.subscription.expiryDate,
  } : null, effectivePlan: access.plan, accessType: access.accessType });
});

app.post('/api/ai/trial/activate', requireSession, requireDatabase, async (req, res) => {
  const plan = req.body?.plan;
  if (!['Premium', 'Exclusive'].includes(plan) || req.body?.termsAccepted !== true) {
    return res.status(400).json({ message: 'Select Premium or Exclusive and accept the trial terms to continue.' });
  }
  const subscription = await currentSubscription(req.session.sub);
  if (subscription) return res.status(409).json({ code: 'PAID_PLAN_ACTIVE', message: 'An active paid subscription cannot be combined with a free trial.' });
  const previousTrial = await AITrial.findOne({ userId: req.session.sub }).lean();
  if (previousTrial) return res.status(409).json({ code: 'TRIAL_ALREADY_USED', message: 'Your free trial has already been used.' });
  const activatedAt = new Date();
  try {
    const [trial] = await AITrial.create([{
      userId: req.session.sub,
      plan,
      status: 'active',
      activatedAt,
      expiresAt: new Date(activatedAt.getTime() + 4 * 24 * 60 * 60 * 1000),
      buildLimit: 2,
      successfulBuilds: 0,
    }]);
    return res.status(201).json({
      trial: { ...aiTrialView(trial.toObject(), activatedAt), eligible: false },
      ...aiAccessResponse(await getAiAccess(req.session.sub)),
      message: 'Your four-day trial is active. Trial activation does not start paid billing or grant cashback.',
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ code: 'TRIAL_ALREADY_USED', message: 'Your free trial has already been used.' });
    throw error;
  }
});

app.post('/api/ai/trial/expiration-warning/claim', requireSession, requireDatabase, async (req, res) => {
  const now = new Date();
  await AITrial.updateMany(
    { userId: req.session.sub, status: 'active', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
  );
  const warningTrial = await AITrial.findOneAndUpdate(
    {
      userId: req.session.sub,
      status: 'active',
      expiresAt: { $gt: now, $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
      expirationWarningShownAt: { $exists: false },
    },
    { $set: { expirationWarningShownAt: now } },
    { new: true },
  ).select('plan expiresAt expirationWarningShownAt').lean();
  return res.json({
    warning: warningTrial ? {
      plan: warningTrial.plan,
      expiresAt: warningTrial.expiresAt,
      shownAt: warningTrial.expirationWarningShownAt,
    } : null,
  });
});

app.post('/api/ai/project-builder', requireSession, requireDatabase, async (req, res) => {
  const idea = typeof req.body?.idea === 'string' ? req.body.idea.trim() : '';
  const budgetValue = req.body?.budget;
  const budget = budgetValue == null || budgetValue === '' ? null : Number(budgetValue);
  const idempotencyKey = req.body?.idempotencyKey;
  if (!idea || idea.length > 2000) return res.status(400).json({ message: 'Enter a project idea between 1 and 2,000 characters.' });
  if (budget !== null && (!Number.isFinite(budget) || budget <= 0 || budget > 1000000)) return res.status(400).json({ message: 'Enter a valid project budget up to ₹10,00,000.' });
  if (!aiIdempotencyKey(idempotencyKey)) return res.status(400).json({ message: 'A valid request key is required. Please try again.' });
  let client;
  try {
    client = getGeminiClient();
  } catch (error) {
    return res.status(error.status || 503).json({ code: error.code || 'AI_UNAVAILABLE', message: error.message });
  }
  const userId = req.session.sub;
  const normalizedRequest = { idea, budget };
  const digest = requestDigest(normalizedRequest);
  const previous = await AIProjectBuild.findOne({ userId, idempotencyKey }).lean();
  if (previous) {
    if (previous.requestHash !== digest) return res.status(409).json({ message: 'This request key was already used for a different project.' });
    if (previous.status === 'succeeded') return res.json(previous.result);
    if (previous.status === 'generating') return res.status(409).json({ message: 'This project is already being generated.' });
    return res.status(409).json({ message: 'This request already failed. Start a new project request to retry.' });
  }

  const now = new Date();
  const recentMinute = await AIProjectBuild.countDocuments({ userId, createdAt: { $gte: new Date(now.getTime() - 60 * 1000) } });
  const recentDay = await AIProjectBuild.countDocuments({ userId, createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } });
  if (recentMinute >= 3 || recentDay >= 20) return res.status(429).json({ message: 'Project generation is temporarily rate-limited. Please wait before trying again.' });
  const access = await getAiAccess(userId);
  if (access.remainingBuilds === 0) {
    return res.status(403).json({ code: 'AI_BUILD_LIMIT', message: `You have used the ${access.buildLimit} project builds available on ${access.plan}. Upgrade to continue building.` });
  }

  let build;
  let quotaReserved = false;
  try {
    build = await AIProjectBuild.create({
      userId,
      idempotencyKey,
      requestHash: digest,
      quotaKey: access.quotaKey,
      plan: access.plan,
      status: 'generating',
    });
    await withMongoTransaction(async (session) => {
      await AIProjectQuota.updateOne(
        { userId, quotaKey: access.quotaKey },
        { $setOnInsert: { userId, quotaKey: access.quotaKey, buildLimit: access.buildLimit, successfulBuilds: 0, pendingBuilds: 0 } },
        { upsert: true, session },
      );
      const quotaFilter = { userId, quotaKey: access.quotaKey };
      if (access.buildLimit != null) quotaFilter.$expr = { $lt: [{ $add: ['$successfulBuilds', '$pendingBuilds'] }, access.buildLimit] };
      const quota = await AIProjectQuota.findOneAndUpdate(quotaFilter, { $inc: { pendingBuilds: 1 } }, { new: true, session });
      if (!quota) throw Object.assign(new Error(`You have used the ${access.buildLimit} project builds available on ${access.plan}. Upgrade to continue building.`), { status: 403, code: 'AI_BUILD_LIMIT' });
    });
    quotaReserved = true;

    const inventory = await InventoryItem.find().sort({ category: 1, name: 1 }).limit(250).select('productId name category description technicalSpecs pricePaise stock status images').lean();
    const catalogForModel = inventory.map((item) => ({
      productId: item.productId,
      name: item.name,
      category: item.category,
      description: String(item.description || '').slice(0, 400),
      specifications: item.technicalSpecs || {},
      price: money(item.pricePaise),
      stock: item.stock,
      stockStatus: item.status,
    }));
    const schema = {
      type: Type.OBJECT,
      properties: {
        projectTitle: { type: Type.STRING },
        description: { type: Type.STRING },
        objective: { type: Type.STRING },
        expectedBehavior: { type: Type.STRING },
        components: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              quantity: { type: Type.INTEGER },
              specifications: { type: Type.STRING },
              wiringHint: { type: Type.STRING },
              catalogProductId: { type: Type.STRING, nullable: true },
            },
            required: ['name', 'quantity', 'specifications', 'wiringHint', 'catalogProductId'],
          },
        },
        wiringPlan: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['projectTitle', 'description', 'objective', 'expectedBehavior', 'components', 'wiringPlan'],
    };
    const response = await client.models.generateContent({
      model: geminiModel,
      contents: [
        'Design a practical Arduino/electronics project only. Return no source code, code snippets, difficulty or stability ratings, interaction scores, payment advice, or invented catalog products. Use only the supplied catalog product IDs when a compatible item is an exact match; otherwise use null and mark that component as unavailable through its missing match in the returned result. Do not claim stock that the catalog does not report. Keep wiring advice cautious when specifications are missing. Respect the user budget if supplied and clearly state assumptions.',
        `User project request: ${idea}`,
        `Budget ceiling INR: ${budget == null ? 'not specified' : budget}`,
        `Current MongoDB catalog: ${JSON.stringify(catalogForModel)}`,
      ].join('\n\n'),
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 4096,
        temperature: 0.35,
      },
    });
    const rawText = response.text?.trim();
    if (!rawText) throw Object.assign(new Error('Gemini returned no project content.'), { status: 502, code: 'AI_INVALID_OUTPUT' });
    let generated;
    try { generated = JSON.parse(rawText); } catch {
      throw Object.assign(new Error('The project response could not be validated. Please try again.'), { status: 502, code: 'AI_INVALID_OUTPUT' });
    }
    const textField = (value, maxLength) => typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !forbiddenProjectCode(value);
    if (!textField(generated.projectTitle, 120) || !textField(generated.description, 1200) || !textField(generated.objective, 600) || !textField(generated.expectedBehavior, 800)
      || !Array.isArray(generated.components) || generated.components.length < 1 || generated.components.length > 30
      || !Array.isArray(generated.wiringPlan) || generated.wiringPlan.length < 1 || generated.wiringPlan.length > 16
      || generated.wiringPlan.some((step) => !textField(step, 400))) {
      throw Object.assign(new Error('The project response did not meet the required format. Please try again.'), { status: 502, code: 'AI_INVALID_OUTPUT' });
    }
    const inventoryById = new Map(inventory.map((item) => [item.productId, item]));
    const components = generated.components.map((component) => {
      if (!textField(component.name, 120) || !Number.isInteger(component.quantity) || component.quantity < 1 || component.quantity > 99
        || typeof component.specifications !== 'string' || component.specifications.length > 500 || forbiddenProjectCode(component.specifications)
        || typeof component.wiringHint !== 'string' || component.wiringHint.length > 500 || forbiddenProjectCode(component.wiringHint)) {
        throw Object.assign(new Error('The project response included an invalid component.'), { status: 502, code: 'AI_INVALID_OUTPUT' });
      }
      const product = typeof component.catalogProductId === 'string' ? inventoryById.get(component.catalogProductId) : null;
      const available = Boolean(product && product.status !== 'Out of Stock' && product.stock >= component.quantity);
      const unitPrice = product ? money(product.pricePaise) : null;
      return {
        name: component.name.trim(),
        quantity: component.quantity,
        specifications: component.specifications.trim(),
        wiringHint: component.wiringHint.trim(),
        available,
        availability: !product ? 'Not available in the Innovation Labs catalog' : available ? product.status : product.status === 'Out of Stock' ? 'Out of stock' : `Only ${product.stock} in stock`,
        product: product ? {
          id: product.productId,
          name: product.name,
          category: product.category,
          description: product.description || '',
          price: unitPrice,
          lineTotal: unitPrice * component.quantity,
          stock: product.stock,
          status: product.status,
          images: (product.images || []).slice(0, 4),
          inventoryProduct: true,
          productUrl: `/products/${encodeURIComponent(product.productId)}`,
        } : null,
      };
    });
    const subtotal = components.reduce((sum, component) => sum + (component.product?.lineTotal || 0), 0);
    const result = {
      projectId: crypto.randomUUID(),
      title: generated.projectTitle.trim(),
      description: generated.description.trim(),
      objective: generated.objective.trim(),
      expectedBehavior: generated.expectedBehavior.trim(),
      components,
      wiringPlan: generated.wiringPlan.map((step) => step.trim()),
      estimatedComponentSubtotal: subtotal,
      estimateNote: 'Estimate uses current catalog prices for matched components only. Shipping, taxes, packaging, coding, construction, and other checkout charges are not included.',
      customBuildingPrompt: [
        `Project objective: ${generated.objective.trim()}`,
        `Expected behaviour: ${generated.expectedBehavior.trim()}`,
        `Required components: ${components.map((component) => `${component.name} × ${component.quantity}`).join('; ')}`,
        `Wiring documentation: Include a clear wiring plan for ${components.map((component) => component.name).join(', ')}. Confirm compatibility wherever specifications are uncertain.`,
        'Building preference: I will select parts only, complete built model, or parts plus coding in the existing Custom Building order form.',
        `Special requirements: ${idea}`,
        'Do not include Arduino source code in this project brief.',
      ].join('\n'),
    };
    const latestAccess = await getAiAccess(userId);
    if (latestAccess.quotaKey !== access.quotaKey || latestAccess.plan !== access.plan) {
      throw Object.assign(new Error('Your project-building entitlement changed while the project was being prepared. Please refresh and try again.'), { status: 403, code: 'AI_ENTITLEMENT_CHANGED' });
    }
    await withMongoTransaction(async (session) => {
      const now = new Date();
      const quotaUpdate = await AIProjectQuota.updateOne(
        { userId, quotaKey: access.quotaKey, pendingBuilds: { $gte: 1 } },
        { $inc: { pendingBuilds: -1, successfulBuilds: 1 } },
        { session },
      );
      if (quotaUpdate.modifiedCount !== 1) throw Object.assign(new Error('Project usage could not be recorded safely.'), { status: 409 });
      if (access.trialMode) {
        const trialUpdate = await AITrial.updateOne(
          { userId, _id: access.trialRecord._id, status: 'active', expiresAt: { $gt: now }, successfulBuilds: { $lt: 2 } },
          { $inc: { successfulBuilds: 1 } },
          { session },
        );
        if (trialUpdate.modifiedCount !== 1) throw Object.assign(new Error('Your trial has expired or used its project-build allowance.'), { status: 403, code: 'AI_TRIAL_EXPIRED' });
      }
      const buildUpdate = await AIProjectBuild.updateOne(
        { _id: build._id, status: 'generating' },
        { $set: { status: 'succeeded', result } },
        { session },
      );
      if (buildUpdate.modifiedCount !== 1) throw Object.assign(new Error('Project build could not be completed safely.'), { status: 409 });
    });
    return res.json({ ...result, entitlements: aiAccessResponse(await getAiAccess(userId)).entitlements });
  } catch (error) {
    if (quotaReserved) {
      await withMongoTransaction(async (session) => {
        await AIProjectQuota.updateOne({ userId, quotaKey: build.quotaKey, pendingBuilds: { $gte: 1 } }, { $inc: { pendingBuilds: -1 } }, { session });
        if (build) await AIProjectBuild.updateOne({ _id: build._id, status: 'generating' }, { $set: { status: 'failed' } }, { session });
      });
    } else if (build) {
      await AIProjectBuild.updateOne({ _id: build._id, status: 'generating' }, { $set: { status: 'failed' } });
    }
    if (error.code === 11000) {
      const duplicate = await AIProjectBuild.findOne({ userId, idempotencyKey }).lean();
      if (duplicate?.requestHash === digest && duplicate.status === 'succeeded') return res.json(duplicate.result);
      return res.status(409).json({ message: 'This project request is already being processed.' });
    }
    if (error.status) return res.status(error.status).json({ code: error.code || 'AI_PROJECT_ERROR', message: error.message });
    console.error('AI Project Builder failed:', error?.name || 'ProviderError');
    return res.status(502).json({ code: 'AI_PROVIDER_UNAVAILABLE', message: 'The AI Project Builder is temporarily unavailable. Please try again.' });
  }
});

const normalizePersistedCartItem = async (item, userId) => {
  const quantity = Number(item?.quantity);
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw Object.assign(new Error('A cart item or quantity is invalid.'), { status: 400 });
  }
  const image = typeof item.image === 'string' ? item.image.slice(0, 2000) : '';
  if (item.promoReservationId) {
    if (quantity !== 1) throw Object.assign(new Error('Promo Codes can only be purchased one at a time.'), { status: 400 });
    const promo = await PromoCode.findOne({
      reservationId: item.promoReservationId,
      status: 'reserved',
      'reservationOwner.userId': userId,
      reservationExpiresAt: { $gt: new Date() },
    }).select('_id reservationId amountPaise purchaseType recipientType').lean();
    if (!promo) throw Object.assign(new Error('This Promo Code reservation is no longer available.'), { status: 409 });
    return {
      id: `promo-${promo.reservationId}`,
      name: 'Digital Wallet Credit',
      category: 'Promo Code',
      price: money(promo.amountPaise),
      quantity: 1,
      image,
      promoCodeId: String(promo._id),
      promoReservationId: promo.reservationId,
      purchaseType: promo.purchaseType,
      recipientType: promo.recipientType,
    };
  }
  if (item.discountOfferId) {
    if (!mongoose.isValidObjectId(item.discountOfferId)) {
      throw Object.assign(new Error('A Discount Promo Code offer is invalid.'), { status: 400 });
    }
    const offer = await DiscountCodeOffer.findById(item.discountOfferId)
      .select('name sellingPricePaise discountType discountValuePaise discountPercent availableQuantity active startsAt expiresAt')
      .lean();
    if (!offer) throw Object.assign(new Error('This Discount Promo Code is no longer available.'), { status: 409 });
    const available = offer.active && offer.startsAt <= new Date() && offer.expiresAt > new Date()
      ? offer.availableQuantity
      : 0;
    return {
      id: `discount-${offer._id}`,
      discountOfferId: String(offer._id),
      name: offer.name,
      category: 'Discount Promo Code',
      price: money(offer.sellingPricePaise),
      quantity,
      image,
      availableQuantity: available,
      status: available > 0 ? 'In Stock' : 'Out of Stock',
      discountLabel: offer.discountType === 'fixed'
        ? `₹${money(offer.discountValuePaise)} off`
        : `${offer.discountPercent}% off`,
    };
  }
  if (item.customOrderId) {
    if (!mongoose.isValidObjectId(item.customOrderId)) {
      throw Object.assign(new Error('A custom item is invalid.'), { status: 400 });
    }
    const customOrder = await CustomOrder.findOne({
      _id: item.customOrderId,
      userId,
      status: 'Accepted',
    }).select('requestedItem price').lean();
    if (!customOrder) throw Object.assign(new Error('This accepted custom item is no longer available.'), { status: 409 });
    return {
      id: `custom-${customOrder._id}`,
      customOrderId: String(customOrder._id),
      name: customOrder.requestedItem,
      category: 'Custom Order',
      price: customOrder.price,
      quantity,
      image,
    };
  }
  const productId = typeof item.id === 'string' ? item.id.trim() : '';
  if (!productId || productId.length > 120) {
    throw Object.assign(new Error('A cart product is invalid.'), { status: 400 });
  }
  const product = await InventoryItem.findOne({ productId }).lean();
  if (!product) throw Object.assign(new Error('A cart product is no longer available.'), { status: 409 });
  return {
    id: product.productId,
    name: product.name,
    category: product.category || 'Other Components',
    price: money(product.pricePaise),
    description: product.description || '',
    quantity,
    image: image || product.images?.[0] || '',
    inventoryProduct: true,
    stock: product.stock,
    status: product.status,
    images: product.images || [],
  };
};

app.get('/api/cart', requireSession, requireDatabase, async (req, res) => {
  const cart = await UserCart.findOne({ userId: req.session.sub }).lean();
  return res.json({ items: cart?.items || [] });
});

app.put('/api/cart', requireSession, requireDatabase, async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length > 100) return res.status(400).json({ message: 'The cart contents are invalid.' });
  const normalized = [];
  for (const item of items) normalized.push(await normalizePersistedCartItem(item, req.session.sub));
  const cart = await UserCart.findOneAndUpdate(
    { userId: req.session.sub },
    { $set: { items: normalized } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  return res.json({ items: cart.items });
});

app.post('/api/ai/add-components-to-cart', requireSession, requireDatabase, async (req, res) => {
  const idempotencyKey = req.body?.idempotencyKey;
  const requested = req.body?.items;
  if (!aiIdempotencyKey(idempotencyKey) || !Array.isArray(requested) || !requested.length || requested.length > 30) {
    return res.status(400).json({ message: 'Choose valid project components and try again.' });
  }
  const access = await getAiAccess(req.session.sub);
  if (!access.canAddComponents) return res.status(403).json({ code: 'AI_CART_UNAVAILABLE', message: 'AI-assisted cart addition requires an active Premium or Exclusive plan, or its eligible trial.' });
  const combined = new Map();
  for (const entry of requested) {
    const productId = typeof entry?.productId === 'string' ? entry.productId.trim() : '';
    const quantity = Number(entry?.quantity);
    const currentQuantity = Number(entry?.currentQuantity || 0);
    if (!productId || productId.length > 120 || !Number.isInteger(quantity) || quantity < 1 || quantity > 99
      || !Number.isInteger(currentQuantity) || currentQuantity < 0 || currentQuantity > 99) {
      return res.status(400).json({ message: 'A project component or quantity is invalid.' });
    }
    const existing = combined.get(productId) || { productId, quantity: 0, currentQuantity };
    existing.quantity += quantity;
    existing.currentQuantity = Math.max(existing.currentQuantity, currentQuantity);
    if (existing.quantity > 99) return res.status(400).json({ message: 'Requested component quantity exceeds the allowed limit.' });
    combined.set(productId, existing);
  }
  const items = [...combined.values()];
  const digest = requestDigest(items);
  const previous = await AIComponentCartAction.findOne({ userId: req.session.sub, idempotencyKey }).lean();
  if (previous) {
    if (previous.requestHash !== digest) return res.status(409).json({ message: 'This cart request key was already used for different components.' });
    return res.json(previous.result);
  }
  const savedCart = await UserCart.findOne({ userId: req.session.sub }).lean();
  const savedQuantityById = new Map((savedCart?.items || []).map((item) => [item.id, Number(item.quantity) || 0]));
  const products = await InventoryItem.find({ productId: { $in: items.map((item) => item.productId) } }).select('productId name category description pricePaise stock status images').lean();
  const byId = new Map(products.map((product) => [product.productId, product]));
  const added = [];
  const unavailable = [];
  for (const item of items) {
    const product = byId.get(item.productId);
    const currentQuantity = savedQuantityById.get(item.productId) || 0;
    const remaining = product ? Math.max(0, product.stock - currentQuantity) : 0;
    if (!product) {
      unavailable.push({ productId: item.productId, requestedQuantity: item.quantity, reason: 'This product is no longer available in the catalog.' });
    } else if (product.status === 'Out of Stock' || remaining < item.quantity) {
      unavailable.push({ productId: item.productId, name: product.name, requestedQuantity: item.quantity, reason: product.status === 'Out of Stock' ? 'This product is out of stock.' : `Only ${remaining} additional unit(s) are available.` });
    } else {
      added.push({
        id: product.productId,
        name: product.name,
        category: product.category,
        description: product.description || '',
        price: money(product.pricePaise),
        quantity: item.quantity,
        stock: product.stock,
        status: product.status,
        images: (product.images || []).slice(0, 4),
        inventoryProduct: true,
      });
    }
  }
  const result = { added, unavailable, message: added.length ? 'Catalog availability verified. These products can be added to your cart.' : 'No requested components could be added.' };
  try {
    await AIComponentCartAction.create([{ userId: req.session.sub, idempotencyKey, requestHash: digest, result }]);
  } catch (error) {
    if (error.code !== 11000) throw error;
    const duplicate = await AIComponentCartAction.findOne({ userId: req.session.sub, idempotencyKey }).lean();
    if (duplicate?.requestHash !== digest) return res.status(409).json({ message: 'This cart request key was already used for different components.' });
    return res.json(duplicate.result);
  }
  return res.json(result);
});

app.post('/api/ai/checkout-assistance', requireSession, requireDatabase, async (req, res) => {
  const access = await getAiAccess(req.session.sub);
  if (!access.canAssistCheckout) return res.status(403).json({ code: 'AI_CHECKOUT_UNAVAILABLE', message: 'AI-assisted checkout preparation is an Exclusive entitlement.' });
  if (typeof req.body?.projectDescription !== 'string' || req.body.projectDescription.length > 4000) return res.status(400).json({ message: 'Project requirements are invalid. Rebuild the project and try again.' });
  const requestedItems = req.body?.items;
  if (!Array.isArray(requestedItems) || !requestedItems.length || requestedItems.length > 50
    || requestedItems.some((item) => item?.promoReservationId || item?.promoCodeId || item?.discountOfferId)) {
    return res.status(400).json({ message: 'Add eligible physical project components before starting checkout assistance.' });
  }
  const service = ['parts', 'coding', 'building', 'full'].includes(req.body?.service) ? req.body.service : 'parts';
  const paymentMethod = req.body?.paymentMethod == null ? null : String(req.body.paymentMethod);
  if (paymentMethod !== null && !['Wallet', 'Online Payment'].includes(paymentMethod)) return res.status(400).json({ message: 'Choose Wallet or Online Payment.' });
  const { safeItems } = await resolveOrderItems(requestedItems.map((item) => ({ id: item?.id, quantity: item?.quantity })), req.session.sub);
  const estimate = calculateOrder(safeItems, service);
  return res.json({
    checkoutPath: '/checkout',
    items: safeItems,
    service,
    preferredPaymentMethod: paymentMethod,
    projectDescription: req.body.projectDescription,
    estimate: {
      subtotal: money(estimate.subtotalPaise),
      codingCharge: money(estimate.codingChargePaise),
      buildingCharge: money(estimate.buildingChargePaise),
      deliveryCharge: money(estimate.deliveryChargePaise),
      totalBeforeDiscounts: money(estimate.totalPaise),
    },
    paymentOptions: ['Wallet', 'Online Payment'],
    requiresUserServiceSelection: true,
    requiresFinalConfirmation: true,
    orderPlaced: false,
  });
});

app.post('/api/ai/action', requireSession, requireDatabase, async (_req, res) => {
  return res.status(403).json({ code: 'AI_FEATURE_LOCKED', message: 'This AI feature is not enabled. Use the AI Project Builder for project design.' });
});

app.get('/api/wallet/access', requireSession, requireDatabase, async (req, res) => {
  const wallet = await Wallet.findOne({ userId: req.session.sub }).lean();
  return res.json({ setupRequired: !wallet?.pinHash });
});

app.get('/api/wallet', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const wallet = await Wallet.findOne({ userId: req.session.sub }).lean();
  if (!wallet?.pinHash) return res.json({ setupRequired: true, wallet: null });
  const transactions = await WalletTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ setupRequired: false, wallet: walletView(wallet, transactions) });
});

app.get('/api/wallet/transfers/account', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const wallet = await Wallet.findOne({ userId: req.session.sub }).select('walletId').lean();
  if (!wallet) return res.status(409).json({ message: 'Create and unlock your wallet before transferring money.' });
  return res.json({ walletId: wallet.walletId || null });
});

app.post('/api/wallet/transfers/wallet-id', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const owner = await Wallet.findOne({ userId: req.session.sub }).select('_id walletId').lean();
  if (!owner) return res.status(409).json({ message: 'Create and unlock your wallet before creating a Wallet ID.' });
  if (owner.walletId) return res.json({ walletId: owner.walletId, existing: true });

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const letters = Array.from(crypto.randomBytes(4), (value) => alphabet[value % alphabet.length]).join('');
    const digits = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const walletId = `@WL${letters}${digits}`;
    try {
      const wallet = await Wallet.findOneAndUpdate(
        { _id: owner._id, walletId: null },
        { $set: { walletId } },
        { new: true, runValidators: true },
      ).select('walletId').lean();
      if (wallet) return res.status(201).json({ walletId: wallet.walletId, existing: false });
      const existing = await Wallet.findOne({ userId: req.session.sub }).select('walletId').lean();
      if (existing?.walletId) return res.json({ walletId: existing.walletId, existing: true });
      return res.status(409).json({ message: 'Your wallet is not available. Please try again.' });
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  return res.status(503).json({ message: 'A unique Wallet ID could not be generated. Please try again.' });
});

app.post('/api/wallet/transfers/recipient', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const walletId = normalizeWalletId(req.body?.walletId);
  if (!validateWalletId(walletId)) return res.status(400).json({ message: 'Enter a valid Wallet ID in @WL plus 4 letters and 4 numbers format.' });
  const recipientWallet = await Wallet.findOne({ walletId }).select('userId').lean();
  if (!recipientWallet) return res.status(404).json({ message: 'Wallet ID not found. Please check the Wallet ID and try again.' });
  if (recipientWallet.userId === req.session.sub) return res.status(400).json({ message: 'You cannot transfer money to your own Wallet ID.' });
  const recipient = await User.findOne({ googleId: recipientWallet.userId }).select('name').lean();
  if (!recipient) return res.status(404).json({ message: 'The account for this Wallet ID could not be found.' });
  return res.json({ recipient: { walletId, displayName: safeRecipientName(recipient?.name) } });
});

app.post('/api/wallet/transfers/quote', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const recipientWalletId = normalizeWalletId(req.body?.recipientWalletId);
  const amountPaise = Number(req.body?.amountPaise);
  if (!validateWalletId(recipientWalletId)) return res.status(400).json({ message: 'Enter a valid recipient Wallet ID.' });
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return res.status(400).json({ message: 'Enter a valid transfer amount greater than ₹0.' });
  const [sender, receiver] = await Promise.all([
    Wallet.findOne({ userId: req.session.sub }).select('balancePaise').lean(),
    Wallet.findOne({ walletId: recipientWalletId }).select('userId').lean(),
  ]);
  if (!sender) return res.status(409).json({ message: 'Your wallet is not available.' });
  if (!receiver) return res.status(404).json({ message: 'Wallet ID not found. Please check the Wallet ID and try again.' });
  if (receiver.userId === req.session.sub) return res.status(400).json({ message: 'You cannot transfer money to your own Wallet ID.' });
  if (sender.balancePaise < amountPaise) {
    return res.status(402).json({ message: `Insufficient Wallet Balance. Your available balance is ${money(sender.balancePaise).toFixed(2)}.`, availableBalance: money(sender.balancePaise) });
  }
  return res.json({ availableBalance: money(sender.balancePaise), balanceAfter: money(sender.balancePaise - amountPaise) });
});

app.post('/api/wallet/transfers/execute', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const recipientWalletId = normalizeWalletId(req.body?.recipientWalletId);
  const amountPaise = Number(req.body?.amountPaise);
  const pin = req.body?.pin;
  const idempotencyKey = typeof req.body?.idempotencyKey === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(req.body.idempotencyKey)
    ? req.body.idempotencyKey
    : null;
  if (!validateWalletId(recipientWalletId)) return res.status(400).json({ message: 'Enter a valid recipient Wallet ID.' });
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return res.status(400).json({ message: 'Enter a valid transfer amount greater than ₹0.' });
  if (!validatePin(pin)) return res.status(400).json({ message: 'Enter your 4-digit Wallet PIN.' });
  if (!idempotencyKey) return res.status(400).json({ message: 'A valid transfer request key is required.' });

  const previousTransfer = await WalletTransfer.findOne({ senderUserId: req.session.sub, idempotencyKey }).lean();
  if (previousTransfer) {
    if (previousTransfer.receiverWalletId !== recipientWalletId || previousTransfer.amountPaise !== amountPaise) {
      return res.status(409).json({ message: 'This transfer request key is already associated with a different transfer.' });
    }
    return res.json({
      transfer: { transferId: previousTransfer.transferId, recipientWalletId: previousTransfer.receiverWalletId, amount: money(previousTransfer.amountPaise), status: previousTransfer.status },
      senderBalance: money(previousTransfer.senderBalanceAfterPaise),
      duplicate: true,
    });
  }

  const senderUser = await User.findOne({ googleId: req.session.sub }).select('_id').lean();
  if (!senderUser) return res.status(404).json({ message: 'The sender account could not be found.' });
  const senderForPin = await Wallet.findOne({ userId: req.session.sub }).select('pinHash lockedUntil').lean();
  if (!senderForPin) return res.status(404).json({ message: 'Your Wallet could not be found.' });
  if (!senderForPin.pinHash) return res.status(409).json({ message: 'Create a Wallet PIN before transferring money.' });
  const now = new Date();
  if (senderForPin.lockedUntil && senderForPin.lockedUntil > now) return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
  if (!verifyPin(pin, senderForPin.pinHash)) {
    const failedWallet = await Wallet.findOneAndUpdate(
      { userId: req.session.sub, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      { $inc: { failedPinAttempts: 1 } },
      { new: true },
    ).select('failedPinAttempts').lean();
    if (!failedWallet) return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
    if (failedWallet.failedPinAttempts >= 5) {
      await Wallet.updateOne({ userId: req.session.sub }, { $set: { failedPinAttempts: 0, lockedUntil: new Date(Date.now() + 5 * 60 * 1000) } });
      return res.status(429).json({ message: 'Too many incorrect PIN attempts. Wallet transfers are locked for 5 minutes.' });
    }
    return res.status(401).json({ message: 'Incorrect Wallet PIN. Please try again.' });
  }

  try {
    const result = await withMongoTransaction(async (session) => {
      const prior = await WalletTransfer.findOne({ senderUserId: req.session.sub, idempotencyKey }).session(session).lean();
      if (prior) {
        if (prior.receiverWalletId !== recipientWalletId || prior.amountPaise !== amountPaise) {
          throw Object.assign(new Error('This transfer request key is already associated with a different transfer.'), { status: 409 });
        }
        return { transfer: prior, duplicate: true };
      }
      const sender = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!sender) throw Object.assign(new Error('Your Wallet could not be found.'), { status: 404 });
      if (!sender.walletId || !sender.pinHash) throw Object.assign(new Error('Your wallet is not ready for transfers.'), { status: 409 });
      if (sender.lockedUntil && sender.lockedUntil > new Date()) throw Object.assign(new Error('Wallet security verification is temporarily locked.'), { status: 429 });
      if (!verifyPin(pin, sender.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
      const receiver = await Wallet.findOne({ walletId: recipientWalletId }).session(session);
      if (!receiver) throw Object.assign(new Error('Wallet ID not found. Please check the Wallet ID and try again.'), { status: 404 });
      if (!await User.exists({ googleId: receiver.userId }).session(session)) throw Object.assign(new Error('The account for this Wallet ID could not be found.'), { status: 404 });
      if (receiver.userId === sender.userId) throw Object.assign(new Error('You cannot transfer money to your own Wallet ID.'), { status: 400 });
      if (sender.balancePaise < amountPaise) throw Object.assign(new Error(`Insufficient Wallet Balance. Your available balance is ${money(sender.balancePaise).toFixed(2)}.`), { status: 402, availableBalance: money(sender.balancePaise) });

      const transferId = `TR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const completedAt = new Date();
      const senderBefore = sender.balancePaise;
      const receiverBefore = receiver.balancePaise;
      sender.balancePaise -= amountPaise;
      receiver.balancePaise += amountPaise;
      sender.failedPinAttempts = 0;
      sender.lockedUntil = undefined;
      await sender.save({ session });
      await receiver.save({ session });
      const [transfer] = await WalletTransfer.create([{
        transferId,
        senderUserId: sender.userId,
        senderWalletId: sender.walletId,
        receiverUserId: receiver.userId,
        receiverWalletId: receiver.walletId,
        amountPaise,
        currency: 'INR',
        status: 'COMPLETED',
        idempotencyKey,
        senderBalanceAfterPaise: sender.balancePaise,
        receiverBalanceAfterPaise: receiver.balancePaise,
        completedAt,
      }], { session });
      const [senderTransaction, receiverTransaction] = await WalletTransaction.create([
        {
          userId: sender.userId,
          type: 'Money Sent',
          amountPaise: -amountPaise,
          balanceBeforePaise: senderBefore,
          balanceAfterPaise: sender.balancePaise,
          referenceId: `transfer:${transferId}:sender`,
          transferId,
          peerWalletId: receiver.walletId,
          description: `Money sent to ${receiver.walletId} · Transfer ${transferId}`,
          status: 'Completed',
        },
        {
          userId: receiver.userId,
          type: 'Money Received',
          amountPaise,
          balanceBeforePaise: receiverBefore,
          balanceAfterPaise: receiver.balancePaise,
          referenceId: `transfer:${transferId}:receiver`,
          transferId,
          peerWalletId: sender.walletId,
          description: `Money received from ${sender.walletId} · Transfer ${transferId}`,
          status: 'Completed',
        },
      ], { session, ordered: true });
      return { transfer, senderTransaction, duplicate: false };
    });
    const transfer = result.transfer.toObject ? result.transfer.toObject() : result.transfer;
    const senderBalance = transfer.senderBalanceAfterPaise;
    const senderTransaction = result.senderTransaction
      ? walletView({ balancePaise: senderBalance }, [result.senderTransaction]).transactions[0]
      : null;
    return res.json({
      transfer: { transferId: transfer.transferId, recipientWalletId: transfer.receiverWalletId, amount: money(transfer.amountPaise), status: transfer.status },
      senderBalance: money(senderBalance),
      senderTransaction,
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message, availableBalance: error.availableBalance });
    if (error.code === 11000) {
      const duplicate = await WalletTransfer.findOne({ senderUserId: req.session.sub, idempotencyKey }).lean();
      if (duplicate && duplicate.receiverWalletId === recipientWalletId && duplicate.amountPaise === amountPaise) return res.json({ transfer: { transferId: duplicate.transferId, recipientWalletId: duplicate.receiverWalletId, amount: money(duplicate.amountPaise), status: duplicate.status }, senderBalance: money(duplicate.senderBalanceAfterPaise), duplicate: true });
      if (duplicate) return res.status(409).json({ message: 'This transfer request key is already associated with a different transfer.' });
    }
    throw error;
  }
});

app.post('/api/wallet/quote', requireSession, requireDatabase, async (req, res) => {
  const { items, service = 'parts', discountCode } = req.body || {};
  if (!['parts', 'coding', 'building', 'full'].includes(service)) return res.status(400).json({ message: 'Choose a valid project service.' });
  try {
    const { safeItems } = await resolveOrderItems(items, req.session.sub);
    const calculated = calculateOrder(safeItems, service);
    const discount = discountCode ? await discountCodeContext({ session: null, userId: req.session.sub, code: discountCode, items: safeItems }) : null;
    const discountAmountPaise = discount?.discountAmountPaise || 0;
    const totalPaise = Math.max(0, calculated.totalPaise - discountAmountPaise);
    const wallet = await Wallet.findOne({ userId: req.session.sub }).lean();
    if (!wallet) return res.status(409).json({ message: 'Create your wallet PIN before paying with Wallet.' });
    return res.json({ balance: hasWalletUnlock(req) ? money(wallet.balancePaise) : null, subtotal: money(calculated.subtotalPaise), discount: money(discountAmountPaise), discountCode: discount?.code || null, delivery: money(calculated.deliveryChargePaise), codingCharge: money(calculated.codingChargePaise), buildingCharge: money(calculated.buildingChargePaise), total: money(totalPaise) });
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message || 'Unable to calculate this order.' });
  }
});

app.get('/api/admin/promo-codes', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const promoCodes = await PromoCode.find().sort({ createdAt: -1 }).lean();
  return res.json({ promoCodes: promoCodes.map((promo) => ({ ...promo, amount: money(promo.amountPaise) })) });
});

app.get('/api/admin/rewards', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const query = String(req.query.q || '').trim();
  const rule = await RewardRule.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default', ...defaultRewardRules } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  const [earned, redeemed, reversed] = await Promise.all(['earned', 'redeemed', 'reversed'].map((transactionType) =>
    RewardTransaction.aggregate([
      { $match: { transactionType } },
      { $group: { _id: null, points: { $sum: '$points' }, count: { $sum: 1 } } },
    ]).then((result) => result[0] || { points: 0, count: 0 }),
  ));
  let filter = {};
  let matchedUserIds = [];
  if (query) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchingUsers = await User.find({ $or: [{ email: new RegExp(escaped, 'i') }, { googleId: new RegExp(escaped, 'i') }] }).select('googleId').lean();
    matchedUserIds = matchingUsers.map((user) => user.googleId);
    filter = { $or: [
      { userId: new RegExp(escaped, 'i') },
      { userEmail: new RegExp(escaped, 'i') },
      { orderId: new RegExp(escaped, 'i') },
      ...(matchedUserIds.length ? [{ userId: { $in: matchedUserIds } }] : []),
    ] };
  }
  const transactions = await RewardTransaction.find(filter).sort({ createdAt: -1 }).limit(query ? 300 : 150).lean();
  const userIds = [...new Set([...transactions.map((transaction) => transaction.userId), ...matchedUserIds])];
  const accounts = await RewardAccount.find(query ? { userId: { $in: userIds } } : {}).sort({ updatedAt: -1 }).limit(300).lean();
  const users = await User.find({ googleId: { $in: accounts.map((account) => account.userId) } }).select('googleId email name').lean();
  const usersById = new Map(users.map((user) => [user.googleId, user]));
  return res.json({
    totals: {
      issuedPoints: earned.points,
      redeemedPoints: redeemed.points,
      reversedPoints: reversed.points,
      transactionCount: earned.count + redeemed.count + reversed.count,
    },
    rules: {
      minimumEligibleAmount: money(rule.minimumEligibleAmountPaise),
      firstTierMaximum: money(rule.firstTierMaximumPaise),
      firstTierPoints: rule.firstTierPoints,
      higherTierPoints: rule.higherTierPoints,
    },
    transactions: transactions.map((transaction) => ({ ...transaction, customer: usersById.get(transaction.userId) || null })),
    accounts: accounts.map((account) => ({ ...account, customer: usersById.get(account.userId) || null })),
  });
});

app.put('/api/admin/rewards/rules', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const minimumAmount = Number(req.body?.minimumEligibleAmount);
  const firstTierMaximum = Number(req.body?.firstTierMaximum);
  const firstTierPoints = Number(req.body?.firstTierPoints);
  const higherTierPoints = Number(req.body?.higherTierPoints);
  if (!Number.isFinite(minimumAmount) || minimumAmount < 0 || !Number.isFinite(firstTierMaximum) || firstTierMaximum <= minimumAmount ||
    !Number.isSafeInteger(firstTierPoints) || firstTierPoints < 0 || firstTierPoints > 1000000 ||
    !Number.isSafeInteger(higherTierPoints) || higherTierPoints < 0 || higherTierPoints > 1000000) {
    return res.status(400).json({ message: 'Enter valid minimum, tier limit, and whole-number reward values.' });
  }
  const rule = await RewardRule.findOneAndUpdate(
    { key: 'default' },
    { $set: {
      minimumEligibleAmountPaise: toPaise(minimumAmount),
      firstTierMaximumPaise: toPaise(firstTierMaximum),
      firstTierPoints,
      higherTierPoints,
      updatedBy: req.session.email,
    } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean();
  return res.json({ rules: {
    minimumEligibleAmount: money(rule.minimumEligibleAmountPaise),
    firstTierMaximum: money(rule.firstTierMaximumPaise),
    firstTierPoints: rule.firstTierPoints,
    higherTierPoints: rule.higherTierPoints,
  } });
});

app.get('/api/admin/discount-offers', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  try {
    await ensureMongoCollections([DiscountCodeOffer, DiscountCodeRegistry, PurchasedDiscountCode]);
    const [offers, purchases] = await Promise.all([
      DiscountCodeOffer.find().sort({ createdAt: -1 }).lean(),
      PurchasedDiscountCode.find({ isScratchReward: false }).sort({ purchasedAt: -1 }).limit(500).lean(),
    ]);
    const userIds = [...new Set(purchases.flatMap((purchase) => [purchase.purchaserUserId, purchase.userId]))];
    const users = await User.find({ googleId: { $in: userIds } }).select('googleId name email').lean();
    const usersById = new Map(users.map((user) => [user.googleId, user]));
    const orders = await Order.find({ orderId: { $in: purchases.map((purchase) => purchase.orderId) } }).select('orderId orderStatus paymentStatus').lean();
    const ordersById = new Map(orders.map((order) => [order.orderId, order]));
    return res.json({
      offers: offers.map((offer) => ({ ...discountOfferView(offer), code: offer.code, active: offer.active, purchasedCount: offer.purchasedCount, redeemedCount: offer.redeemedCount, maxRedemptions: offer.maxRedemptions, maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer, discountValuePaise: offer.discountValuePaise, discountPercent: offer.discountPercent, minimumPurchase: money(offer.minimumPurchasePaise), startsAt: offer.startsAt, expiresAt: offer.expiresAt })),
      purchases: purchases.map((purchase) => ({ ...purchase, purchaser: usersById.get(purchase.purchaserUserId) || null, recipient: usersById.get(purchase.userId) || null, order: ordersById.get(purchase.orderId) || null })),
    });
  } catch (error) {
    console.error('[discount-offers-list]', error.name, error.code || '', error.message);
    return res.status(503).json({ message: 'Discount offers could not be loaded from the database. Please retry.' });
  }
});

app.post('/api/admin/discount-offers/generate-code', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  try {
    return res.json({ code: await generateUniqueDiscountCode(null) });
  } catch (error) {
    console.error('[discount-code-generate]', error.name, error.code || '');
    return res.status(error.status || 503).json({ message: 'A unique discount promo code could not be generated. Please retry.' });
  }
});

const standardDiscountDenominations = [1, ...Array.from({ length: 10 }, (_, index) => (index + 1) * 100), ...Array.from({ length: 9 }, (_, index) => (index + 2) * 1000)];

app.post('/api/admin/discount-offers/generate-standard', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const generateNewCodes = req.body?.generateNewCodes === true;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000);
  const createdOfferIds = [];
  const createdCodes = [];
  try {
    await ensureMongoCollections([DiscountCodeOffer, DiscountCodeRegistry]);
    const created = [];
    const skipped = [];
    for (const denomination of standardDiscountDenominations) {
      const amountPaise = toPaise(denomination);
      const offerName = `₹${denomination.toLocaleString('en-IN')} Discount Promo Code`;
      if (!generateNewCodes) {
        const existing = await DiscountCodeOffer.findOne({
          name: offerName,
          active: true,
          discountType: 'fixed',
          sellingPricePaise: amountPaise,
          discountValuePaise: amountPaise,
        }).lean();
        if (existing) {
          skipped.push(denomination);
          continue;
        }
      }
      const code = await generateUniqueDiscountCode(null);
      const offer = await DiscountCodeOffer.create({
        code,
        name: offerName,
        source: 'AI_GENERATED',
        sellingPricePaise: amountPaise,
        discountType: 'fixed',
        discountValuePaise: amountPaise,
        discountPercent: 0,
        startsAt: now,
        expiresAt,
        maxRedemptions: 100000,
        maxRedemptionsPerCustomer: 1,
        availableQuantity: 1,
        minimumPurchasePaise: 0,
        eligibilityType: 'all',
        active: true,
      });
      createdOfferIds.push(offer._id);
      createdCodes.push(code);
      await DiscountCodeRegistry.create({ code, sourceType: 'offer', sourceId: String(offer._id) });
      created.push({ denomination, code, offerId: String(offer._id) });
    }
    return res.status(201).json({
      created,
      skipped,
      denominations: standardDiscountDenominations,
    });
  } catch (error) {
    if (createdOfferIds.length) {
      await Promise.all([
        DiscountCodeOffer.deleteMany({ _id: { $in: createdOfferIds } }),
        DiscountCodeRegistry.deleteMany({ code: { $in: createdCodes } }),
      ]).catch((rollbackError) => {
        console.error('[discount-standard-generation-rollback]', rollbackError.name, rollbackError.code || '', rollbackError.message);
      });
    }
    if (error.code === 11000) return res.status(409).json({ message: 'A generated code already exists. Retry to generate a different unique code.' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ message: 'A standard discount offer failed validation. No generated offers were committed.' });
    }
    console.error('[discount-standard-generation]', error.name, error.code || '', error.message, classifyDatabaseError(error));
    return res.status(503).json({ message: 'MongoDB could not complete standard offer generation. Any offers created by this attempt were rolled back; please retry.' });
  }
});

app.post('/api/admin/discount-offers', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const name = String(req.body?.offerName ?? req.body?.name ?? '').trim();
  const sellingPricePaise = toPaise(req.body?.sellingPrice);
  const discountType = req.body?.discountType;
  const customerDiscountValuePaise = toPaise(req.body?.customerDiscountValue ?? req.body?.discountValue);
  const discountPercent = Number(req.body?.discountPercent);
  const startsAt = new Date(req.body?.startsAt);
  const expiresAt = new Date(req.body?.expiresAt);
  const maxRedemptions = Number(req.body?.maxRedemptions);
  const maxRedemptionsPerCustomer = Number(req.body?.maxRedemptionsPerCustomer);
  const availableQuantity = Number(req.body?.availableQuantity);
  const minimumPurchasePaise = toPaise(req.body?.minimumPurchase || 0);
  const eligibilityType = req.body?.eligibilityType;
  const active = req.body?.active;
  const eligibleCategories = [...new Set((Array.isArray(req.body?.eligibleCategories) ? req.body.eligibleCategories : []).map((value) => String(value).trim()).filter(Boolean))];
  const eligibleProductIds = [...new Set((Array.isArray(req.body?.eligibleProductIds) ? req.body.eligibleProductIds : []).map((value) => String(value).trim()).filter(Boolean))];
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code) || !name || name.length > 100 || !Number.isSafeInteger(sellingPricePaise) || sellingPricePaise < 0 ||
    !['fixed', 'percentage'].includes(discountType) || !Number.isSafeInteger(maxRedemptions) || maxRedemptions < 1 ||
    !Number.isSafeInteger(maxRedemptionsPerCustomer) || maxRedemptionsPerCustomer < 1 || maxRedemptionsPerCustomer > maxRedemptions ||
    !Number.isSafeInteger(availableQuantity) || availableQuantity < 1 || !Number.isSafeInteger(minimumPurchasePaise) || minimumPurchasePaise < 0 ||
    !['all', 'categories', 'products'].includes(eligibilityType) ||
    typeof active !== 'boolean' ||
    (eligibilityType === 'categories' && !eligibleCategories.length) ||
    (eligibilityType === 'products' && !eligibleProductIds.length) ||
    Number.isNaN(startsAt.getTime()) || Number.isNaN(expiresAt.getTime()) || expiresAt <= startsAt ||
    (discountType === 'fixed' && (!Number.isSafeInteger(customerDiscountValuePaise) || customerDiscountValuePaise < 1)) ||
    (discountType === 'percentage' && (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100))) {
    return res.status(400).json({ message: 'Enter a unique code in XXXX-XXXX-XXXX-XXXX format and valid offer, eligibility, dates, and redemption limits.' });
  }
  if (eligibilityType === 'categories') {
    const existingCategories = new Set([...catalogPrices.values()].map((product) => product[1]));
    (await InventoryItem.distinct('category')).filter(Boolean).forEach((category) => existingCategories.add(category));
    if (eligibleCategories.some((category) => !existingCategories.has(category))) return res.status(400).json({ message: 'Choose eligible product categories from the catalog.' });
  }
  if (eligibilityType === 'products') {
    const existingProductIds = new Set([...catalogPrices.keys(), ...await InventoryItem.distinct('productId')]);
    if (eligibleProductIds.some((productId) => !existingProductIds.has(productId))) return res.status(400).json({ message: 'Choose eligible products from the catalog.' });
  }
  try {
    await ensureMongoCollections([DiscountCodeOffer, DiscountCodeRegistry]);
    const [existingPurchase, existingWalletCode] = await Promise.all([
      PurchasedDiscountCode.exists({ code }),
      PromoCode.exists({ code }),
    ]);
    if (existingPurchase || existingWalletCode || await DiscountCodeOffer.exists({ code }) || await DiscountCodeRegistry.exists({ code })) {
      return res.status(409).json({ message: 'A Discount Promo Code with that code already exists.' });
    }
    const offer = await DiscountCodeOffer.create({
      code,
      name,
      source: 'ADMIN',
      sellingPricePaise,
      discountType,
      discountValuePaise: discountType === 'fixed' ? customerDiscountValuePaise : 0,
      discountPercent: discountType === 'percentage' ? discountPercent : 0,
      startsAt,
      expiresAt,
      maxRedemptions,
      maxRedemptionsPerCustomer,
      availableQuantity,
      minimumPurchasePaise,
      eligibilityType,
      eligibleCategories: eligibilityType === 'categories' ? eligibleCategories : [],
      eligibleProductIds: eligibilityType === 'products' ? eligibleProductIds : [],
      active,
    });
    try {
      await DiscountCodeRegistry.create({ code, sourceType: 'offer', sourceId: String(offer._id) });
    } catch (registryError) {
      await DiscountCodeOffer.deleteOne({ _id: offer._id });
      throw registryError;
    }
    return res.status(201).json({ offer: { ...discountOfferView(offer.toObject()), code, active, purchasedCount: 0, redeemedCount: 0 } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'A Discount Promo Code with that code already exists.' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ message: 'Discount offer fields are invalid. Check the values and dates, then retry.' });
    }
    const databaseErrorType = classifyDatabaseError(error);
    console.error('[discount-offer-create]', error.name, error.code || '', error.message, databaseErrorType);
    return res.status(databaseErrorType !== 'unknown' ? 503 : 500).json({
      message: databaseErrorType !== 'unknown'
        ? 'MongoDB could not complete the discount offer save. Check the database connection and retry.'
        : 'The discount offer could not be saved. Please retry.',
    });
  }
});

app.patch('/api/admin/discount-offers/:id/status', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Discount offer was not found.' });
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ message: 'Choose whether the offer is active.' });
  const offer = await DiscountCodeOffer.findByIdAndUpdate(req.params.id, { $set: { active: req.body.active } }, { new: true }).lean();
  if (!offer) return res.status(404).json({ message: 'Discount offer was not found.' });
  return res.json({ offer: { ...discountOfferView(offer), code: offer.code, active: offer.active, purchasedCount: offer.purchasedCount, redeemedCount: offer.redeemedCount, maxRedemptions: offer.maxRedemptions, maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer } });
});

app.get('/api/admin/scratch-cards', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const settings = await ScratchSettings.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  const cards = await ScratchCard.find().sort({ createdAt: -1 }).limit(500).lean();
  const purchases = await PurchasedDiscountCode.find({ purchaseId: { $in: cards.map((card) => card.discountPurchaseId) } }).lean();
  const purchasesById = new Map(purchases.map((purchase) => [purchase.purchaseId, purchase]));
  const users = await User.find({ googleId: { $in: cards.map((card) => card.userId) } }).select('googleId name email').lean();
  const usersById = new Map(users.map((user) => [user.googleId, user]));
  return res.json({
    settings: {
      enabled: settings.enabled,
      threshold: money(settings.thresholdPaise),
      rewardValues: settings.rewardValuesPaise.map(money),
      discountType: settings.discountType || 'fixed',
      minimumPurchase: money(settings.minimumPurchasePaise || 0),
      eligibilityType: settings.eligibilityType || 'all',
      eligibleCategories: settings.eligibleCategories || [],
      eligibleProductIds: settings.eligibleProductIds || [],
      expiryDays: settings.expiryDays,
      maxRedemptions: settings.maxRedemptions,
      transferable: settings.transferable,
    },
    scratchCards: cards.map((card) => ({ ...card, eligibleOrderAmount: money(card.eligibleOrderAmountPaise), rewardValue: money(card.rewardValuePaise), rewardType: card.rewardType || 'fixed', customer: usersById.get(card.userId) || null, rewardCode: purchasesById.get(card.discountPurchaseId)?.code || null })),
  });
});

app.put('/api/admin/scratch-cards/settings', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const enabled = req.body?.enabled;
  const thresholdPaise = toPaise(req.body?.threshold);
  const rewardValuesPaise = Array.isArray(req.body?.rewardValues) ? req.body.rewardValues.map(toPaise) : [];
  const discountType = req.body?.discountType;
  const minimumPurchasePaise = toPaise(req.body?.minimumPurchase);
  const eligibilityType = req.body?.eligibilityType;
  const eligibleCategories = [...new Set((Array.isArray(req.body?.eligibleCategories) ? req.body.eligibleCategories : []).map((value) => String(value).trim()).filter(Boolean))];
  const eligibleProductIds = [...new Set((Array.isArray(req.body?.eligibleProductIds) ? req.body.eligibleProductIds : []).map((value) => String(value).trim()).filter(Boolean))];
  const expiryDays = Number(req.body?.expiryDays);
  const maxRedemptions = Number(req.body?.maxRedemptions);
  const transferable = req.body?.transferable;
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(thresholdPaise) || thresholdPaise < 0 || !rewardValuesPaise.length ||
    rewardValuesPaise.length > 20 || rewardValuesPaise.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !['fixed', 'percentage'].includes(discountType) ||
    (discountType === 'percentage' && rewardValuesPaise.some((value) => value > 10000)) ||
    !Number.isSafeInteger(minimumPurchasePaise) || minimumPurchasePaise < 0 ||
    !['all', 'categories', 'products'].includes(eligibilityType) ||
    (eligibilityType === 'categories' && !eligibleCategories.length) ||
    (eligibilityType === 'products' && !eligibleProductIds.length) ||
    !Number.isSafeInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650 || !Number.isSafeInteger(maxRedemptions) || maxRedemptions < 1 ||
    typeof transferable !== 'boolean') return res.status(400).json({ message: 'Enter valid scratch-card settings and positive reward values.' });
  if (eligibilityType === 'categories') {
    const existingCategories = new Set([...catalogPrices.values()].map((product) => product[1]));
    (await InventoryItem.distinct('category')).filter(Boolean).forEach((category) => existingCategories.add(category));
    if (eligibleCategories.some((category) => !existingCategories.has(category))) return res.status(400).json({ message: 'Choose eligible product categories from the catalog.' });
  }
  if (eligibilityType === 'products') {
    const existingProductIds = new Set([...catalogPrices.keys(), ...await InventoryItem.distinct('productId')]);
    if (eligibleProductIds.some((productId) => !existingProductIds.has(productId))) return res.status(400).json({ message: 'Choose eligible products from the catalog.' });
  }
  const settings = await ScratchSettings.findOneAndUpdate(
    { key: 'default' },
    { $set: {
      enabled,
      thresholdPaise,
      rewardValuesPaise,
      discountType,
      minimumPurchasePaise,
      eligibilityType,
      eligibleCategories: eligibilityType === 'categories' ? eligibleCategories : [],
      eligibleProductIds: eligibilityType === 'products' ? eligibleProductIds : [],
      expiryDays,
      maxRedemptions,
      transferable,
      updatedBy: req.session.email,
    } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean();
  return res.json({ settings: {
    enabled: settings.enabled,
    threshold: money(settings.thresholdPaise),
    rewardValues: settings.rewardValuesPaise.map(money),
    discountType: settings.discountType,
    minimumPurchase: money(settings.minimumPurchasePaise),
    eligibilityType: settings.eligibilityType,
    eligibleCategories: settings.eligibleCategories,
    eligibleProductIds: settings.eligibleProductIds,
    expiryDays: settings.expiryDays,
    maxRedemptions: settings.maxRedemptions,
    transferable: settings.transferable,
  } });
});

app.get('/api/admin/invoices', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const query = String(req.query.q || '').trim();
  const filter = query ? { $or: [
    { invoiceNumber: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { orderId: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { customerEmail: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { customerName: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { userId: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
  ] } : {};
  const invoices = await Invoice.find(filter).sort({ createdAt: -1 }).limit(300).select('-pdfData').lean();
  const creditNotes = await CreditNote.find({ ...(query ? { $or: [filter.$or[1], filter.$or[2]] } : {}) }).sort({ createdAt: -1 }).limit(300).lean();
  return res.json({ invoices, creditNotes });
});

app.get('/api/admin/invoices/:invoiceId/download', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const invoice = await Invoice.findOne({ $or: [{ invoiceId: req.params.invoiceId }, { invoiceNumber: req.params.invoiceId }, { orderId: req.params.invoiceId }] }).select('+pdfData');
  if (!invoice?.pdfData) return res.status(404).json({ message: 'Invoice PDF was not found.' });
  if (!Buffer.isBuffer(invoice.pdfData) || invoice.pdfData.length < 5 || invoice.pdfData.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return res.status(500).json({ message: 'The stored invoice PDF is invalid.' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  return res.send(invoice.pdfData);
});

app.get('/api/admin/orders', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 }).limit(200).lean();
  return res.json({ orders: await adminOrdersView(orders) });
});

app.get('/api/admin/orders/:id', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  let order = null;
  if (mongoose.isValidObjectId(req.params.id)) {
    order = await Order.findById(req.params.id).lean();
  }
  if (!order) {
    order = await Order.findOne({ orderId: req.params.id }).lean();
  }
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  return res.json({ order: (await adminOrdersView([order]))[0] });
});

app.patch('/api/admin/orders/:id/accept', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Order was not found.' });
  const { estimatedDelivery } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  const deliveryDate = new Date(estimatedDelivery || Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(deliveryDate.getTime())) return res.status(400).json({ message: 'Enter a valid delivery date.' });

  try {
    const accepted = await withMongoTransaction(async (session) => {
      const current = await Order.findById(order._id).session(session);
      if (!current) throw Object.assign(new Error('Order was not found.'), { status: 404 });
      if (current.orderStatus === 'Cancelled' || current.cancelledAt) throw Object.assign(new Error('A cancelled order cannot be accepted.'), { status: 409 });
      if (current.orderStatus === 'Accepted') return current.toObject();
      if (current.orderType === 'PROMO_CODE') {
        if (current.purchaseType !== 'offline' || current.orderStatus !== 'Pending Admin Approval' || current.paymentStatus !== 'Paid') {
          throw Object.assign(new Error('Only paid offline Promo Code orders awaiting approval can be accepted.'), { status: 409 });
        }
        const promo = await PromoCode.findOne({ _id: current.promoCodeId, orderId: current.orderId, status: 'pending_approval', purchaseType: 'offline' }).session(session);
        if (!promo) throw Object.assign(new Error('The reserved Promo Code is no longer available for fulfillment.'), { status: 409 });
        const activatedAt = new Date();
        activatePromoCode(promo, activatedAt);
        const recipientUserId = current.recipientType === 'gift' && current.recipientUserId ? current.recipientUserId : current.userId;
        const recipient = recipientUserId === current.userId
          ? null
          : await User.findOne({ googleId: recipientUserId }).select('googleId name email').session(session).lean();
        if (recipientUserId !== current.userId && (!recipient || recipient.email !== current.recipientEmail)) {
          throw Object.assign(new Error('The offline gift recipient could not be verified for fulfillment.'), { status: 409 });
        }
        promo.status = 'purchased';
        promo.purchasedBy = { userId: recipientUserId, name: recipient?.name || current.userName, email: recipient?.email || current.userEmail };
        promo.purchasedAt = new Date();
        await promo.save({ session });
        current.promoCode = promo.code;
        current.promoCodeStatus = 'PURCHASED';
        current.promoActivationStatus = 'active';
        current.promoActivatedAt = promo.activatedAt;
        current.promoExpiresAt = promo.expiresAt;
        current.promoMaxUses = promo.maxUses || 10;
        current.promoSuccessfulUses = promo.successfulUses || 0;
        current.recipientUserId = recipientUserId === current.userId ? undefined : recipientUserId;
        current.recipientEmail = recipient?.email || current.recipientEmail;
        current.orderStatus = 'Accepted';
        current.approvalStatus = 'accepted';
        current.acceptedAt = new Date();
        current.estimatedDelivery = deliveryDate;
        current.statusHistory = [...(current.statusHistory || []), { status: 'Accepted', note: 'Offline Promo Code order accepted by admin; Promo Code activated for the customer.', createdAt: new Date() }];
        await current.save({ session });
        await awardRewardPointsForOrder(session, current);
        const notifications = [{ userId: current.userId, message: `Your offline Promo Code order ${current.orderId} was accepted and fulfilled.` }];
        if (recipientUserId !== current.userId) notifications.push({
          userId: recipientUserId,
          type: 'promo_gift_received',
          data: { orderId: current.orderId, buyerName: current.userName, buyerEmail: current.userEmail, promoName: 'Digital Wallet Credit', amount: money(promo.amountPaise), receivedAt: activatedAt },
          message: `You received a Promo Code gift from ${current.userName}. It is ready in your Wallet.`,
        });
        await Notification.create(notifications, { session });
        return current.toObject();
      }
      if (!current.inventoryDeductedAt) current.inventoryDeductedAt = await applyInventoryReduction(session, current.items);
      current.orderStatus = 'Accepted';
      current.acceptedAt = new Date();
      current.estimatedDelivery = deliveryDate;
      current.statusHistory = [...(current.statusHistory || []), { status: 'Accepted', note: 'Order accepted by admin', createdAt: new Date() }];
      await current.save({ session });
      await Notification.create([{ userId: current.userId, message: `Order ${current.orderId} has been accepted and is now being processed.` }], { session });
      return current.toObject();
    });
    return res.json({ order: accepted });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

const rejectOfflinePromoOrder = async ({ orderId, reason, adminEmail: declinedBy }) => withMongoTransaction(async (session) => {
  const current = await Order.findById(orderId).session(session);
  if (!current) throw Object.assign(new Error('Order was not found.'), { status: 404 });
  if (current.orderStatus === 'Rejected' && current.refundCaseId) {
    const existingRefund = await Refund.findOne({ refundCaseId: current.refundCaseId, orderId: current.orderId, userId: current.userId }).session(session);
    if (existingRefund?.status === 'REFUND_COMPLETED') {
      const wallet = await Wallet.findOne({ userId: current.userId }).session(session);
      return { order: current.toObject(), refund: existingRefund.toObject(), walletBalance: wallet?.balancePaise ?? null, duplicate: true };
    }
  }
  if (current.orderType !== 'PROMO_CODE' || current.purchaseType !== 'offline' || current.orderStatus !== 'Pending Admin Approval') {
    throw Object.assign(new Error('Only offline Promo Code orders awaiting approval can be rejected.'), { status: 409 });
  }
  if (current.paymentStatus !== 'Paid') throw Object.assign(new Error('Only paid orders can be rejected and refunded.'), { status: 409 });
  const promo = await PromoCode.findOne({ _id: current.promoCodeId, orderId: current.orderId, status: 'pending_approval', purchaseType: 'offline' }).session(session);
  if (!promo) throw Object.assign(new Error('The reserved Promo Code for this order could not be verified.'), { status: 409 });
  const refundAmountPaise = toPaise(current.total);
  const itemAmountPaise = (current.items || []).reduce((sum, item) => sum + toPaise(item.price) * item.quantity, 0);
  if (!Number.isSafeInteger(refundAmountPaise) || refundAmountPaise <= 0 || refundAmountPaise !== promo.amountPaise || itemAmountPaise !== refundAmountPaise || toPaise(current.subtotal) !== refundAmountPaise) {
    throw Object.assign(new Error('The saved Promo Code payment breakdown is invalid; no refund was issued.'), { status: 409 });
  }
  if (current.paymentMethod === 'Wallet') {
    const originalPayment = await WalletTransaction.findOne({ userId: current.userId, orderId: current.orderId, type: 'Purchase', amountPaise: -refundAmountPaise, status: 'Successful' }).session(session).lean();
    if (!originalPayment) throw Object.assign(new Error('The original Wallet payment could not be verified; no refund was issued.'), { status: 409 });
  } else if (current.paymentMethod !== 'Razorpay' || !current.razorpayId) {
    throw Object.assign(new Error('The original payment could not be verified; no refund was issued.'), { status: 409 });
  }
  const wallet = await Wallet.findOneAndUpdate(
    { userId: current.userId },
    { $setOnInsert: { userId: current.userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session },
  );
  const balanceBeforePaise = wallet.balancePaise;
  const balanceAfterPaise = balanceBeforePaise + refundAmountPaise;
  if (!Number.isSafeInteger(balanceAfterPaise)) throw Object.assign(new Error('The customer Wallet balance cannot accept this refund.'), { status: 409 });
  const now = new Date();
  const refundCaseId = `RF-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const transactionReferenceId = `offline-promo-refund:${current.orderId}`;
  if (await WalletTransaction.exists({ referenceId: transactionReferenceId }).session(session)) {
    throw Object.assign(new Error('A refund transaction already exists for this order.'), { status: 409 });
  }
  wallet.balancePaise = balanceAfterPaise;
  await wallet.save({ session });
  const [transaction] = await WalletTransaction.create([{
    userId: current.userId,
    type: 'Refund',
    amountPaise: refundAmountPaise,
    balanceBeforePaise,
    balanceAfterPaise,
    referenceId: transactionReferenceId,
    orderId: current.orderId,
    refundCaseId,
    description: `Refund for rejected offline Promo Code order ${current.orderId}`,
    status: 'Completed',
  }], { session });
  const [refund] = await Refund.create([{
    refundCaseId,
    orderId: current.orderId,
    userId: current.userId,
    userName: current.userName,
    userEmail: current.userEmail,
    originalOrderAmountPaise: refundAmountPaise,
    calculatedRefundAmountPaise: refundAmountPaise,
    approvedRefundAmountPaise: refundAmountPaise,
    refundAmountPaise,
    itemsSnapshot: current.items,
    orderSnapshot: { createdAt: current.createdAt, total: money(refundAmountPaise), subtotal: money(refundAmountPaise), deliveryCharge: 0, paymentMethod: current.paymentMethod, paymentStatus: current.paymentStatus, purchaseType: 'offline' },
    reason: String(reason || 'Order rejected by admin.').trim().slice(0, 500),
    reasonCategory: 'Offline Promo Order Rejection',
    adminReason: String(reason || 'Order rejected by admin.').trim().slice(0, 500),
    walletTransactionId: transaction._id,
    walletTransactionReferenceId: transactionReferenceId,
    status: 'REFUND_COMPLETED',
    statusHistory: [{ status: 'REFUND_COMPLETED', changedBy: declinedBy, note: 'Offline Promo Code order rejected; payment amount credited to customer Wallet.', createdAt: now }],
    adminAudit: [{ adminId: declinedBy, action: 'offline_promo_order_rejected_refunded', timestamp: now, oldStatus: current.orderStatus, newStatus: 'Rejected', amountPaise: refundAmountPaise, reason: String(reason || 'Order rejected by admin.').trim().slice(0, 500) }],
  }], { session });
  await PromoCode.updateOne(
    { _id: promo._id, status: 'pending_approval', orderId: current.orderId },
    { $set: { status: 'unused' }, $unset: { reservationId: 1, reservationKey: 1, reservationOwner: 1, reservationExpiresAt: 1, paymentMethod: 1, purchaseType: 1, recipientType: 1, giftRecipientId: 1, giftRecipientEmail: 1, giftBuyerId: 1, giftBuyerName: 1, giftBuyerEmail: 1, buyerAddress: 1, recipientAddress: 1, purchaseIdempotencyKey: 1, razorpayOrderId: 1, razorpayPaymentId: 1, purchasedBy: 1, purchasedAt: 1, orderId: 1 } },
    { session },
  );
  current.orderStatus = 'Rejected';
  current.approvalStatus = 'rejected';
  current.promoCodeStatus = undefined;
  current.promoActivationStatus = 'rejected';
  current.refundCaseId = refundCaseId;
  current.refundAmountPaise = refundAmountPaise;
  current.refundTransactionReferenceId = transactionReferenceId;
  current.statusHistory = [...(current.statusHistory || []), { status: 'Rejected', note: `Rejected by admin. ₹${money(refundAmountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} was credited to the customer Wallet.`, createdAt: now }];
  await current.save({ session });
  await createCreditNoteForRefund(session, { userId: current.userId, orderId: current.orderId, refundCaseId, amountPaise: refundAmountPaise, reason: 'Offline Promo Code order rejected.' });
  await Notification.create([{ userId: current.userId, message: `Your offline Promo Code order ${current.orderId} was rejected. ₹${money(refundAmountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} was refunded to your Wallet.` }], { session });
  return { order: current.toObject(), refund: refund.toObject(), walletBalance: wallet.balancePaise, duplicate: false };
});

app.patch('/api/admin/orders/:id/decline', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Order was not found.' });
  const { reason = '' } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  if (order.orderType === 'PROMO_CODE') {
    if (order.purchaseType !== 'offline') return res.status(409).json({ message: 'Online Promo Code orders are already confirmed and cannot be declined.' });
    try {
      const result = await rejectOfflinePromoOrder({ orderId: order._id, reason, adminEmail: req.session.email });
      return res.json({ order: result.order, refund: result.refund, wallet: result.walletBalance == null ? undefined : { balance: money(result.walletBalance) }, duplicate: result.duplicate });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      if (error.code === 11000) return res.status(409).json({ message: 'This offline Promo Code order has already been processed.' });
      throw error;
    }
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const current = await Order.findById(order._id).session(session);
      if (!current) throw Object.assign(new Error('Order was not found.'), { status: 404 });
      if (current.orderStatus === 'Cancelled' || current.cancelledAt) throw Object.assign(new Error('A cancelled order cannot be declined.'), { status: 409 });
      if (current.orderStatus === 'Declined') {
        const existingRefund = await Refund.findOne({ orderId: current.orderId, userId: current.userId, reasonCategory: 'Order Decline' }).session(session);
        if (existingRefund?.status === 'REFUND_COMPLETED') {
          const wallet = await Wallet.findOne({ userId: current.userId }).session(session);
          return { order: current.toObject(), refund: existingRefund.toObject(), walletBalance: wallet?.balancePaise ?? null, duplicate: true };
        }
        throw Object.assign(new Error('This order has already been declined without a completed automatic refund.'), { status: 409 });
      }
      if (current.orderType === 'PROMO_CODE') throw Object.assign(new Error('Promo Code orders are not eligible for an order-decline refund.'), { status: 409 });
      if (current.paymentStatus !== 'Paid') throw Object.assign(new Error('Only paid orders can receive an automatic decline refund.'), { status: 409 });
      if (current.paymentMethod !== 'Wallet') throw Object.assign(new Error('Automatic decline refunds are currently supported only for Wallet-paid orders. Use the original payment method refund process for this order.'), { status: 409 });
      if (current.refundCaseId) throw Object.assign(new Error('A refund case already exists for this order.'), { status: 409 });

      const customer = await User.findOne({ googleId: current.userId }).session(session).lean();
      if (!customer) throw Object.assign(new Error('The customer account for this order could not be found.'), { status: 404 });
      const wallet = await Wallet.findOne({ userId: current.userId }).session(session);
      if (!wallet) throw Object.assign(new Error('The customer Wallet could not be found; the order was not declined.'), { status: 409 });

      const partsAmountPaise = toPaise(current.subtotal);
      const codingChargePaise = toPaise(current.codingCharge || 0);
      const buildingChargePaise = toPaise(current.buildingCharge || 0);
      const deliveryChargePaise = toPaise(current.deliveryCharge || 0);
      const totalPaidPaise = toPaise(current.total);
      const itemSnapshotAmountPaise = (current.items || []).reduce((sum, item) => {
        const itemPricePaise = toPaise(item.price);
        if (!Number.isSafeInteger(itemPricePaise) || !Number.isSafeInteger(item.quantity) || item.quantity < 1) return NaN;
        return sum + itemPricePaise * item.quantity;
      }, 0);
      if (!Number.isSafeInteger(partsAmountPaise) || partsAmountPaise <= 0 ||
        !Number.isSafeInteger(codingChargePaise) || codingChargePaise < 0 ||
        !Number.isSafeInteger(buildingChargePaise) || buildingChargePaise < 0 ||
        !Number.isSafeInteger(deliveryChargePaise) || deliveryChargePaise < 0 ||
        !Number.isSafeInteger(totalPaidPaise) || totalPaidPaise <= 0 ||
        partsAmountPaise > totalPaidPaise || itemSnapshotAmountPaise !== partsAmountPaise ||
        partsAmountPaise + codingChargePaise + buildingChargePaise + deliveryChargePaise !== totalPaidPaise) {
        throw Object.assign(new Error('The saved order payment breakdown is invalid; no refund or decline was recorded.'), { status: 409 });
      }
      const originalPayment = await WalletTransaction.findOne({
        userId: current.userId,
        orderId: current.orderId,
        type: 'Purchase',
        amountPaise: -totalPaidPaise,
        status: 'Successful',
      }).session(session).lean();
      if (!originalPayment) throw Object.assign(new Error('The original Wallet payment could not be verified; no refund or decline was recorded.'), { status: 409 });
      const nextBalancePaise = wallet.balancePaise + partsAmountPaise;
      if (!Number.isSafeInteger(nextBalancePaise)) throw Object.assign(new Error('The customer Wallet balance cannot accept this refund.'), { status: 409 });

      const now = new Date();
      const declineReason = String(reason || 'Order declined by admin.').trim().slice(0, 500);
      const refundCaseId = `RF-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const transactionReferenceId = `order-decline-refund:${current.orderId}`;
      const existingTransaction = await WalletTransaction.findOne({ referenceId: transactionReferenceId }).session(session);
      if (existingTransaction) throw Object.assign(new Error('An automatic decline refund transaction already exists for this order.'), { status: 409 });

      await restoreInventoryForOrder(session, current);
      const balanceBeforePaise = wallet.balancePaise;
      wallet.balancePaise = nextBalancePaise;
      await wallet.save({ session });
      const [transaction] = await WalletTransaction.create([{
        userId: current.userId,
        type: 'Order Decline Refund',
        amountPaise: partsAmountPaise,
        balanceBeforePaise,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: transactionReferenceId,
        orderId: current.orderId,
        refundCaseId,
        description: `Refund for order ${current.orderId} declined by admin; non-refundable service and delivery charges excluded.`,
        status: 'Completed',
      }], { session });
      const statusHistory = [
        { status: 'ORDER_DECLINED', changedBy: req.session.email, note: declineReason, createdAt: now },
        { status: 'REFUND_COMPLETED', changedBy: req.session.email, note: `₹${money(partsAmountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} parts amount credited to the customer Wallet.`, createdAt: now },
      ];
      const [refund] = await Refund.create([{
        refundCaseId,
        orderId: current.orderId,
        userId: current.userId,
        userName: current.userName,
        userEmail: current.userEmail,
        originalOrderAmountPaise: totalPaidPaise,
        calculatedRefundAmountPaise: partsAmountPaise,
        approvedRefundAmountPaise: partsAmountPaise,
        refundAmountPaise: partsAmountPaise,
        itemsSnapshot: (current.items || []).map(({ id, name, category, price, quantity }) => ({ id, name, category, price, quantity })),
        orderSnapshot: {
          createdAt: current.createdAt,
          total: money(totalPaidPaise),
          subtotal: money(partsAmountPaise),
          codingCharge: money(codingChargePaise),
          buildingCharge: money(buildingChargePaise),
          deliveryCharge: money(deliveryChargePaise),
          paymentMethod: current.paymentMethod,
          paymentStatus: current.paymentStatus,
        },
        reason: declineReason,
        reasonCategory: 'Order Decline',
        adminReason: declineReason,
        walletTransactionId: transaction._id,
        walletTransactionReferenceId: transactionReferenceId,
        status: 'REFUND_COMPLETED',
        statusHistory,
        adminAudit: [{ adminId: req.session.email, action: 'automatic_order_decline_refund', timestamp: now, oldStatus: current.orderStatus, newStatus: 'REFUND_COMPLETED', amountPaise: partsAmountPaise, reason: declineReason }],
      }], { session });

      current.orderStatus = 'Declined';
      current.refundCaseId = refundCaseId;
      current.statusHistory = [...(current.statusHistory || []), { status: 'Declined', note: `${declineReason} ₹${money(partsAmountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} parts refund credited to Wallet.`, createdAt: now }];
      await current.save({ session });
      await reverseRewardPointsForOrder(session, current.toObject(), { referenceId: transactionReferenceId, refundAmountPaise: partsAmountPaise });
      await releaseDiscountRedemptionForOrder(session, current.orderId);
      await createCreditNoteForRefund(session, { userId: current.userId, orderId: current.orderId, refundCaseId, amountPaise: partsAmountPaise, reason: declineReason });
      await Notification.create([{ userId: current.userId, message: `Your order ${current.orderId} was declined by the admin. ₹${money(partsAmountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} refundable parts amount has been credited to your Wallet.` }], { session });
      return { order: current.toObject(), refund: refund.toObject(), walletBalance: wallet.balancePaise, duplicate: false };
    });
    const refundCase = {
      _id: result.refund._id,
      refundCaseId: result.refund.refundCaseId,
      status: result.refund.status,
      refundAmountPaise: result.refund.refundAmountPaise,
      approvedRefundAmountPaise: result.refund.approvedRefundAmountPaise,
      reasonCategory: result.refund.reasonCategory,
      walletTransactionReferenceId: result.refund.walletTransactionReferenceId,
    };
    return res.json({
      order: { ...result.order, refundCase },
      refund: result.refund,
      wallet: result.walletBalance == null ? undefined : { balance: money(result.walletBalance) },
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) {
      const [current, refund] = await Promise.all([
        Order.findById(order._id).lean(),
        Refund.findOne({ orderId: order.orderId, userId: order.userId, reasonCategory: 'Order Decline' }).lean(),
      ]);
      if (current?.orderStatus === 'Declined' && refund?.status === 'REFUND_COMPLETED') {
        const wallet = await Wallet.findOne({ userId: order.userId }).select('balancePaise').lean();
        const refundCase = { _id: refund._id, refundCaseId: refund.refundCaseId, status: refund.status, refundAmountPaise: refund.refundAmountPaise, approvedRefundAmountPaise: refund.approvedRefundAmountPaise, reasonCategory: refund.reasonCategory, walletTransactionReferenceId: refund.walletTransactionReferenceId };
        return res.json({ order: { ...current, refundCase }, refund, wallet: wallet ? { balance: money(wallet.balancePaise) } : undefined, duplicate: true });
      }
      return res.status(409).json({ message: 'An automatic decline refund transaction already exists for this order.' });
    }
    throw error;
  }
});

app.get('/api/admin/inventory', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const inventory = await InventoryItem.find().sort({ name: 1 }).lean();
  return res.json({ inventory });
});

app.post('/api/admin/inventory', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const { productId, name, category = 'Other Components', pricePaise, description = '', stock = 0 } = req.body || {};
  const normalizedProductId = String(productId || '').trim();
  const normalizedName = String(name || '').trim();
  const normalizedCategory = String(category || 'Other Components').trim().slice(0, 80);
  const normalizedPrice = Number(pricePaise ?? 0);
  const normalizedStock = Number(stock);
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  const technicalSpecs = req.body?.technicalSpecs && typeof req.body.technicalSpecs === 'object' && !Array.isArray(req.body.technicalSpecs) ? req.body.technicalSpecs : {};
  const safeImages = images.map((value) => String(value).trim()).filter(Boolean);
  const safeTechnicalSpecs = Object.fromEntries(Object.entries(technicalSpecs).slice(0, 30).map(([key, value]) => [
    String(key).trim().slice(0, 80),
    String(value).trim().slice(0, 300),
  ]).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(key) && value));
  const stockInputValid = typeof stock === 'number' || typeof stock === 'string' && /^\d+$/.test(stock);
  if (!normalizedProductId || !normalizedName || !Number.isFinite(normalizedPrice) || normalizedPrice < 0 || !stockInputValid || !Number.isSafeInteger(normalizedStock) || normalizedStock < 0) {
    return res.status(400).json({ message: 'Provide a product ID, item name, valid price, and non-negative whole-number stock.' });
  }
  if (images.length > 8 || safeImages.length !== images.filter((value) => String(value).trim()).length || safeImages.some((image) => image.length > 2048 || !(image.startsWith('/') && !image.startsWith('//') || /^https?:\/\//i.test(image)))) {
    return res.status(400).json({ message: 'Provide up to 8 valid image URLs.' });
  }
  const previous = await InventoryItem.findOne({ productId: normalizedProductId }).select('stock').lean();
  const item = await InventoryItem.findOneAndUpdate(
    { productId: normalizedProductId },
    {
      $set: {
        productId: normalizedProductId,
        name: normalizedName,
        category: normalizedCategory || 'Other Components',
        pricePaise: Math.round(normalizedPrice),
        description: String(description).slice(0, 1000),
        images: safeImages,
        technicalSpecs: safeTechnicalSpecs,
        stock: normalizedStock,
        status: normalizedStock > 5 ? 'In Stock' : normalizedStock > 0 ? 'Low Stock' : 'Out of Stock',
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  if ((previous?.stock || 0) < 1 && normalizedStock > 0) await notifyBackInStockSubscribers(normalizedProductId, item.name);
  return res.status(201).json({ inventoryItem: item });
});

app.patch('/api/admin/inventory/:productId/stock', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  const rawStock = req.body?.stock;
  const stock = Number(rawStock);
  const stockInputValid = typeof rawStock === 'number' || typeof rawStock === 'string' && /^\d+$/.test(rawStock);
  if (!productId || !stockInputValid || !Number.isSafeInteger(stock) || stock < 0) {
    return res.status(400).json({ message: 'Stock must be a non-negative whole number.' });
  }
  const previous = await InventoryItem.findOne({ productId }).select('stock').lean();
  const inventoryItem = await InventoryItem.findOneAndUpdate(
    { productId },
    { $set: { stock, status: stock > 5 ? 'In Stock' : stock > 0 ? 'Low Stock' : 'Out of Stock', updatedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!inventoryItem) return res.status(404).json({ message: 'Inventory item was not found.' });
  if ((previous?.stock || 0) < 1 && stock > 0) await notifyBackInStockSubscribers(productId, inventoryItem.name);
  return res.json({ inventoryItem });
});

app.get('/api/admin/settings', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const maxActiveOrders = await getOrderLimit();
  return res.json({ settings: { maxActiveOrders } });
});

app.patch('/api/admin/settings/max-active-orders', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const value = Number(req.body?.value);
  if (!Number.isInteger(value) || value < 1) return res.status(400).json({ message: 'Set the order capacity to a valid integer greater than zero.' });
  const setting = await AdminSetting.findOneAndUpdate(
    { key: 'max_active_orders' },
    { $set: { key: 'max_active_orders', value, updatedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return res.json({ settings: { maxActiveOrders: setting.value } });
});

app.post('/api/admin/promo-codes', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const amountPaise = Number(req.body?.amountPaise);
  const validityDays = Number(req.body?.validityDays ?? 30);
  const validityHours = Number(req.body?.validityHours ?? 0);
  const validityMinutes = Number(req.body?.validityMinutes ?? 0);
  const maxUses = Number(req.body?.maxUses ?? 10);
  const durationPartsValid = [validityDays, validityHours, validityMinutes].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    validityHours < 24 && validityMinutes < 60;
  const validitySeconds = validityDays * 86400 + validityHours * 3600 + validityMinutes * 60;
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code)) return res.status(400).json({ message: 'Promo code must use XXXX-XXXX-XXXX-XXXX format.' });
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) return res.status(400).json({ message: 'Promo amount must be greater than ₹0.' });
  if (!durationPartsValid || !Number.isSafeInteger(validitySeconds) || validitySeconds < 60 || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    return res.status(400).json({ message: 'Enter a valid promo validity of at least one minute and a maximum use limit from 1 to 1,000.' });
  }
  try {
    const promoCode = await PromoCode.create({ code, amountPaise, validitySeconds, maxUses, successfulUses: 0, status: 'unused', createdBy: req.session.sub });
    return res.status(201).json({ promoCode: { ...promoCode.toObject(), amount: money(promoCode.amountPaise) } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ code: 'PROMO_EXISTS', message: 'Promo code already exists. Please enter a different promo code.' });
    throw error;
  }
});

app.patch('/api/admin/promo-codes/:id/deactivate', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Promo code was not found.' });
  const promoCode = await PromoCode.findOneAndUpdate({ _id: req.params.id, status: 'unused' }, { $set: { status: 'deactivated' } }, { returnDocument: 'after' }).lean();
  if (!promoCode) return res.status(409).json({ message: 'Only unused promo codes can be deactivated.' });
  return res.json({ promoCode: { ...promoCode, amount: money(promoCode.amountPaise) } });
});

const promoReservationMs = 30 * 60 * 1000;
const releaseExpiredPromoReservations = async () => {
  await PromoCode.updateMany(
    { status: 'reserved', reservationExpiresAt: { $lte: new Date() } },
    {
      $set: { status: 'unused' },
      $unset: { reservationId: 1, reservationKey: 1, reservationOwner: 1, reservationExpiresAt: 1, paymentMethod: 1, purchaseType: 1, recipientType: 1, giftRecipientId: 1, giftRecipientEmail: 1, giftBuyerId: 1, giftBuyerName: 1, giftBuyerEmail: 1, buyerAddress: 1, recipientAddress: 1, razorpayOrderId: 1 },
    },
  );
};

app.get('/api/promo-codes/available', requireSession, requireDatabase, async (_req, res) => {
  await releaseExpiredPromoReservations();
  await expirePromoCodes();
  const promoCodes = await PromoCode.find({ status: 'unused', $or: [{ maxUses: { $exists: false } }, { $expr: { $lt: ['$successfulUses', '$maxUses'] } }] }).select('amountPaise createdAt validitySeconds maxUses successfulUses').sort({ createdAt: -1 }).lean();
  return res.json({ promoCodes: promoCodes.map((promo) => { const maxUses = promo.maxUses || 10; const successfulUses = promo.successfulUses || 0; return { id: String(promo._id), name: 'Digital Wallet Credit', amount: money(promo.amountPaise), createdAt: promo.createdAt, validitySeconds: promo.validitySeconds, maxUses, successfulUses, remainingUses: Math.max(0, maxUses - successfulUses), available: true }; }) });
});

app.post('/api/promo-codes/reserve', requireSession, requireDatabase, async (req, res) => {
  const { promoCodeId, reservationKey, purchaseType, recipientType = 'myself' } = req.body || {};
  if (!mongoose.isValidObjectId(promoCodeId)) return res.status(400).json({ message: 'Choose a valid Promo Code.' });
  if (!['online', 'offline'].includes(purchaseType)) return res.status(400).json({ message: 'Choose Online Purchase or Offline Purchase.' });
  if (!['myself', 'gift'].includes(recipientType)) return res.status(400).json({ message: 'Choose For Myself or Gift Purchase.' });
  if (typeof reservationKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(reservationKey)) return res.status(400).json({ message: 'A valid reservation key is required.' });
  await releaseExpiredPromoReservations();
  await expirePromoCodes();
  const existing = await PromoCode.findOne({ 'reservationOwner.userId': req.session.sub, reservationKey }).lean();
  if (existing) {
    if (String(existing._id) !== promoCodeId) return res.status(409).json({ message: 'This reservation key is already in use.' });
    if (existing.status === 'reserved' && existing.purchaseType === purchaseType && existing.recipientType === recipientType) return res.json({ reservationId: existing.reservationId, purchaseType: existing.purchaseType, recipientType: existing.recipientType, promoCode: { id: String(existing._id), name: 'Digital Wallet Credit', amount: money(existing.amountPaise), available: true }, expiresAt: existing.reservationExpiresAt });
    if (existing.status === 'reserved') return res.status(409).json({ message: 'This reservation already uses a different purchase type.' });
  }
  const now = new Date();
  const reservationId = `PR-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(now.getTime() + promoReservationMs);
  const promo = await PromoCode.findOneAndUpdate(
    { _id: promoCodeId, status: 'unused', $or: [{ maxUses: { $exists: false } }, { $expr: { $lt: ['$successfulUses', '$maxUses'] } }] },
    { $set: { status: 'reserved', reservationId, reservationKey, reservationOwner: { userId: req.session.sub }, reservationExpiresAt: expiresAt, paymentMethod: null, purchaseType, recipientType, giftBuyerId: req.session.sub, giftBuyerName: req.session.name || req.session.email.split('@')[0], giftBuyerEmail: req.session.email }, $unset: { giftRecipientId: 1, giftRecipientEmail: 1, buyerAddress: 1, recipientAddress: 1 } },
    { new: true },
  ).lean();
  if (!promo) return res.status(409).json({ message: 'This Promo Code is no longer available.' });
  return res.status(201).json({ reservationId, purchaseType: promo.purchaseType, recipientType: promo.recipientType, promoCode: { id: String(promo._id), name: 'Digital Wallet Credit', amount: money(promo.amountPaise), available: true }, expiresAt });
});

app.post('/api/promo-codes/reservations/:reservationId/recipient', requireSession, requireDatabase, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ message: 'Enter a valid recipient email address.' });
  const now = Date.now();
  const attemptKey = req.session.sub;
  const attempt = giftRecipientAttempts.get(attemptKey) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempt.resetAt <= now) {
    attempt.count = 0;
    attempt.resetAt = now + 15 * 60 * 1000;
  }
  attempt.count += 1;
  giftRecipientAttempts.set(attemptKey, attempt);
  if (attempt.count > 10) return res.status(429).json({ message: 'Recipient verification is temporarily limited. Please try again later.' });

  const promo = await PromoCode.findOne({
    reservationId: req.params.reservationId,
    status: 'reserved',
    'reservationOwner.userId': req.session.sub,
    purchaseType: 'online',
    recipientType: 'gift',
    reservationExpiresAt: { $gt: new Date() },
  });
  if (!promo) return res.status(404).json({ message: 'This gift reservation is no longer available.' });
  const recipient = await User.findOne({ email }).select('googleId email').lean();
  if (!recipient) return res.status(404).json({ message: 'This email address is not registered with Innovation Labs. Please ask the recipient to create an account first.' });
  promo.giftRecipientId = recipient.googleId;
  promo.giftRecipientEmail = recipient.email;
  await promo.save();
  return res.json({ verified: true, email: recipient.email });
});

app.get('/api/promo-codes/reservations/:reservationId', requireSession, requireDatabase, async (req, res) => {
  let promo = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub }).lean();
  if (!promo) return res.status(404).json({ message: 'Promo Code reservation was not found.' });
  if (promo.status === 'reserved' && promo.reservationExpiresAt <= new Date()) {
    await releaseExpiredPromoReservations();
    return res.status(409).json({ message: 'This Promo Code reservation expired. Add the code to your cart again.' });
  }
  if (!['reserved', 'pending_approval', 'purchased', 'used'].includes(promo.status)) return res.status(409).json({ message: 'This Promo Code reservation is no longer available.' });
  const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise').lean();
  const order = ['reserved'].includes(promo.status) ? null : await Order.findOne({ orderId: promo.orderId, userId: req.session.sub }).lean();
  return res.json({
    reservationId: promo.reservationId,
    status: promo.status,
    purchaseType: promo.purchaseType || 'online',
    recipientType: promo.recipientType || 'myself',
    giftRecipientEmail: promo.giftRecipientEmail || null,
    paymentMethod: promo.paymentMethod || null,
    promoCode: { id: String(promo._id), name: 'Digital Wallet Credit', amount: money(promo.amountPaise), code: promo.recipientType === 'gift' ? null : ['purchased', 'used'].includes(promo.status) ? promo.code : null, available: promo.status === 'reserved' || promo.status === 'purchased' },
    expiresAt: promo.reservationExpiresAt,
    walletBalance: wallet && hasWalletUnlock(req) ? money(wallet.balancePaise) : null,
    orderId: promo.status === 'reserved' ? null : promo.orderId,
    order: buyerOrderView(order),
  });
});

app.post('/api/promo-codes/reservations/:reservationId/release', requireSession, requireDatabase, async (req, res) => {
  const released = await PromoCode.findOneAndUpdate(
    { reservationId: req.params.reservationId, status: 'reserved', 'reservationOwner.userId': req.session.sub },
    { $set: { status: 'unused' }, $unset: { reservationId: 1, reservationKey: 1, reservationOwner: 1, reservationExpiresAt: 1, paymentMethod: 1, purchaseType: 1, recipientType: 1, giftRecipientId: 1, giftRecipientEmail: 1, giftBuyerId: 1, giftBuyerName: 1, giftBuyerEmail: 1, buyerAddress: 1, recipientAddress: 1, razorpayOrderId: 1 } },
  );
  return res.json({ released: Boolean(released) });
});

app.patch('/api/promo-codes/reservations/:reservationId/payment-method', requireSession, requireDatabase, async (req, res) => {
  const paymentMethod = req.body?.paymentMethod;
  if (!['Wallet', 'Razorpay'].includes(paymentMethod)) return res.status(400).json({ message: 'Choose Wallet or Razorpay.' });
  const promo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', 'reservationOwner.userId': req.session.sub, reservationExpiresAt: { $gt: new Date() } }).lean();
  if (!promo) return res.status(409).json({ message: 'This Promo Code reservation expired or is no longer available.' });
  if (promo.razorpayOrderId && promo.paymentMethod !== paymentMethod) return res.status(409).json({ message: 'A Razorpay payment has already been started for this reservation.' });
  const updated = await PromoCode.findOneAndUpdate(
    { _id: promo._id, status: 'reserved', reservationId: promo.reservationId, 'reservationOwner.userId': req.session.sub, reservationExpiresAt: { $gt: new Date() } },
    { $set: { paymentMethod } },
    { new: true },
  ).lean();
  if (!updated) return res.status(409).json({ message: 'This Promo Code reservation is no longer available.' });
  return res.json({ paymentMethod: updated.paymentMethod });
});

app.post('/api/promo-codes/reservations/:reservationId/pay-wallet', requireSession, requireDatabase, async (req, res) => {
  const { pin, idempotencyKey, address, buyerAddress, recipientAddress, recipientEmail } = req.body || {};
  if (!validatePin(pin)) return res.status(400).json({ message: 'Enter your 4-digit Wallet PIN.' });
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid purchase key is required.' });
  const alreadyPurchased = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, status: { $in: ['pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed'] } }).lean();
  if (alreadyPurchased) {
    if (alreadyPurchased.purchaseIdempotencyKey !== idempotencyKey) return res.status(409).json({ message: 'This Promo Code has already been purchased.' });
    const order = await Order.findOne({ orderId: alreadyPurchased.orderId, userId: req.session.sub }).lean();
    const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise').lean();
    return res.json({ promoCode: alreadyPurchased.recipientType === 'gift' || alreadyPurchased.purchaseType === 'offline' && !alreadyPurchased.purchasedBy?.userId ? null : { code: alreadyPurchased.code, amount: money(alreadyPurchased.amountPaise) }, order: buyerOrderView(order), wallet: { balance: money(wallet?.balancePaise || 0) }, duplicate: true });
  }
  const reservedPromo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', 'reservationOwner.userId': req.session.sub }).select('purchaseType recipientType giftRecipientId').lean();
  if (reservedPromo?.purchaseType === 'online' && reservedPromo.recipientType === 'gift' && !reservedPromo.giftRecipientId) return res.status(409).json({ message: 'Verify the gift recipient email before continuing to payment.' });
  if (reservedPromo?.purchaseType === 'offline') {
    if (!validateAddress(recipientAddress || address)) return res.status(400).json({ message: 'Complete the recipient delivery address fields for Offline Purchase.' });
    if (reservedPromo.recipientType === 'gift' && !validateAddress(buyerAddress)) return res.status(400).json({ message: 'Complete the buyer contact address fields for Offline Gift Purchase.' });
  }
  const pinWallet = await Wallet.findOne({ userId: req.session.sub }).select('pinHash failedPinAttempts lockedUntil').lean();
  if (!pinWallet?.pinHash) return res.status(409).json({ message: 'Create a Wallet PIN before paying from your Wallet.' });
  if (pinWallet.lockedUntil && pinWallet.lockedUntil > new Date()) return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
  if (!verifyPin(pin, pinWallet.pinHash)) {
    const failedWallet = await Wallet.findOneAndUpdate({ userId: req.session.sub, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }] }, { $inc: { failedPinAttempts: 1 } }, { new: true }).select('failedPinAttempts').lean();
    if (!failedWallet) return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
    if (failedWallet.failedPinAttempts >= 5) {
      await Wallet.updateOne({ userId: req.session.sub }, { $set: { failedPinAttempts: 0, lockedUntil: new Date(Date.now() + 5 * 60 * 1000) } });
      return res.status(429).json({ message: 'Too many incorrect PIN attempts. Wallet payments are locked for 5 minutes.' });
    }
    return res.status(401).json({ message: 'Incorrect Wallet PIN. Please try again.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const existing = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, status: { $in: ['pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed'] } }).session(session).lean();
      if (existing) {
        if (existing.purchaseIdempotencyKey !== idempotencyKey) throw Object.assign(new Error('This Promo Code has already been purchased.'), { status: 409 });
        const order = await Order.findOne({ orderId: existing.orderId, userId: req.session.sub }).session(session).lean();
        const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session).lean();
        return { promoCode: existing.purchaseType === 'offline' && !existing.purchasedBy?.userId ? null : existing, order, wallet, duplicate: true };
      }
      const promo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', reservationOwner: { userId: req.session.sub }, reservationExpiresAt: { $gt: new Date() }, paymentMethod: 'Wallet' }).session(session);
      if (!promo) throw Object.assign(new Error('This Promo Code reservation expired or is unavailable for Wallet payment.'), { status: 409 });
      const recipient = await resolvePromoRecipient(session, { promo, userId: req.session.sub, userEmail: req.session.email, recipientEmail });
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet || !verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
      if (wallet.lockedUntil && wallet.lockedUntil > new Date()) throw Object.assign(new Error('Wallet security verification is temporarily locked.'), { status: 429 });
      if (wallet.balancePaise < promo.amountPaise) throw Object.assign(new Error(`Insufficient Wallet Balance. Required: ₹${money(promo.amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} · Available: ₹${money(wallet.balancePaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`), { status: 402 });
      const before = wallet.balancePaise;
      wallet.balancePaise -= promo.amountPaise;
      wallet.failedPinAttempts = 0;
      wallet.lockedUntil = undefined;
      await wallet.save({ session });
      const customerDetails = {
        promo,
        reservationId: promo.reservationId,
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        paymentMethod: 'Wallet',
        idempotencyKey,
        walletBalanceAfterPaise: wallet.balancePaise,
      };
      const completed = promo.purchaseType === 'offline'
        ? await createOfflinePromoCodeOrder(session, { ...customerDetails, address: recipientAddress || address, buyerAddress, recipientAddress: recipientAddress || address, ...recipient, recipientType: promo.recipientType })
        : await completePromoCodeOrder(session, customerDetails);
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Purchase',
        amountPaise: -promo.amountPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: `promo-purchase:${promo.reservationId}`,
        orderId: completed.order.orderId,
        description: `Promo Code purchase ${completed.order.orderId}`,
        status: 'Successful',
      }], { session });
      return { ...completed, wallet: wallet.toObject(), duplicate: false };
    });
    return res.json({ promoCode: result.promoCode && result.order.recipientType !== 'gift' ? { code: result.promoCode.code, amount: money(result.promoCode.amountPaise) } : null, order: buyerOrderView(result.order), wallet: { balance: money(result.wallet.balancePaise) }, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) {
      const duplicate = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, purchaseIdempotencyKey: idempotencyKey, status: { $in: ['pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed'] } }).lean();
      if (duplicate) {
        const order = await Order.findOne({ orderId: duplicate.orderId, userId: req.session.sub }).lean();
        const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise').lean();
        return res.json({ promoCode: duplicate.recipientType === 'gift' || duplicate.purchaseType === 'offline' && !duplicate.purchasedBy?.userId ? null : { code: duplicate.code, amount: money(duplicate.amountPaise) }, order: buyerOrderView(order), wallet: { balance: money(wallet?.balancePaise || 0) }, duplicate: true });
      }
      return res.status(409).json({ message: 'This Promo Code has already been purchased.' });
    }
    throw error;
  }
});

app.post('/api/promo-codes/reservations/:reservationId/razorpay/order', requireSession, requireDatabase, async (req, res) => {
  const { buyerAddress, recipientAddress, address, recipientEmail } = req.body || {};
  const promo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', reservationOwner: { userId: req.session.sub }, reservationExpiresAt: { $gt: new Date() }, paymentMethod: 'Razorpay' });
  if (!promo) return res.status(409).json({ message: 'This Promo Code reservation expired or is unavailable for Razorpay.' });
  if (promo.purchaseType === 'online' && promo.recipientType === 'gift' && !promo.giftRecipientId) return res.status(409).json({ message: 'Verify the gift recipient email before continuing to payment.' });
  if (promo.purchaseType === 'offline') {
    const deliveryAddress = recipientAddress || address;
    if (!validateAddress(deliveryAddress)) return res.status(400).json({ message: 'Complete the delivery address before payment.' });
    if (promo.recipientType === 'gift' && !validateAddress(buyerAddress)) return res.status(400).json({ message: 'Complete the buyer contact address before payment.' });
    if (!promo.razorpayOrderId) {
      const recipient = await resolvePromoRecipient(null, { promo, userId: req.session.sub, userEmail: req.session.email, recipientEmail });
      promo.buyerAddress = buyerAddress || undefined;
      promo.recipientAddress = deliveryAddress;
      promo.giftRecipientId = recipient.recipientUserId || undefined;
      promo.giftRecipientEmail = recipient.recipientEmail || undefined;
      await promo.save();
    }
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for Promo Code purchases.' });
  if (promo.razorpayOrderId) return res.json({ orderId: promo.razorpayOrderId, keyId: razorpayKeyId, amountPaise: promo.amountPaise, promoCode: 'Digital Wallet Credit' });
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: promo.amountPaise, currency: 'INR', receipt: `promo-${promo.reservationId}`, expire_by: Math.floor(promo.reservationExpiresAt.getTime() / 1000) }),
    });
    const razorpayOrder = await response.json();
    if (!response.ok) return res.status(502).json({ message: 'Razorpay could not create the Promo Code payment.' });
    const updated = await PromoCode.findOneAndUpdate(
      { _id: promo._id, status: 'reserved', reservationId: promo.reservationId, 'reservationOwner.userId': req.session.sub, paymentMethod: 'Razorpay', razorpayOrderId: { $in: [null, ''] } },
      { $set: { razorpayOrderId: razorpayOrder.id } },
      { new: true },
    ).lean();
    if (!updated) {
      const winner = await PromoCode.findById(promo._id).lean();
      if (!winner?.razorpayOrderId) return res.status(409).json({ message: 'This Promo Code reservation is no longer available.' });
      return res.json({ orderId: winner.razorpayOrderId, keyId: razorpayKeyId, amountPaise: winner.amountPaise, promoCode: 'Digital Wallet Credit' });
    }
    return res.json({ orderId: updated.razorpayOrderId, keyId: razorpayKeyId, amountPaise: updated.amountPaise, promoCode: 'Digital Wallet Credit' });
  } catch {
    return res.status(503).json({ message: 'Promo Code online payment is temporarily unavailable.' });
  }
});

app.post('/api/promo-codes/reservations/:reservationId/razorpay/verify', requireSession, requireDatabase, async (req, res) => {
  const orderId = req.body?.razorpay_order_id;
  const paymentId = req.body?.razorpay_payment_id;
  const signature = req.body?.razorpay_signature;
  if (![orderId, paymentId, signature].every((value) => typeof value === 'string' && value)) return res.status(400).json({ message: 'Promo Code payment verification details are incomplete.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for Promo Code purchases.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (expectedSignature !== signature) return res.status(401).json({ message: 'Payment verification failed.' });
  const promo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', reservationOwner: { userId: req.session.sub }, paymentMethod: 'Razorpay', razorpayOrderId: orderId }).lean();
  if (!promo) {
    const offlinePurchase = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, status: 'pending_approval', razorpayPaymentId: paymentId }).lean();
    if (offlinePurchase) {
      const order = await Order.findOne({ orderId: offlinePurchase.orderId, userId: req.session.sub }).lean();
      return res.json({ promoCode: null, order: buyerOrderView(order), duplicate: true });
    }
    const purchased = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, razorpayPaymentId: paymentId, status: { $in: ['purchased', 'used', 'expired', 'fully_redeemed'] } }).lean();
    if (purchased) {
      const order = await Order.findOne({ orderId: purchased.orderId, userId: req.session.sub }).lean();
      return res.json({ promoCode: purchased.recipientType === 'gift' ? null : { code: purchased.code, amount: money(purchased.amountPaise) }, order: buyerOrderView(order), duplicate: true });
    }
    return res.status(404).json({ message: 'Promo Code reservation was not found.' });
  }
  if (promo.purchaseType === 'online' && promo.recipientType === 'gift' && !promo.giftRecipientId) return res.status(409).json({ message: 'Verify the gift recipient email before continuing to payment.' });
  if (promo.purchaseType === 'offline' && (!validateAddress(promo.recipientAddress) || promo.recipientType === 'gift' && !validateAddress(promo.buyerAddress))) return res.status(409).json({ message: 'The saved delivery addresses could not be verified.' });
  try {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` } });
    const payment = await response.json();
    if (!response.ok || payment.amount !== promo.amountPaise || payment.order_id !== orderId || payment.currency !== 'INR' || payment.status !== 'captured') {
      return res.status(409).json({ message: 'Payment amount or status could not be verified.' });
    }
  } catch {
    return res.status(503).json({ message: 'Promo Code payment verification is temporarily unavailable.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const current = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', reservationOwner: { userId: req.session.sub }, paymentMethod: 'Razorpay', razorpayOrderId: orderId, reservationExpiresAt: { $gt: new Date() } }).session(session);
      if (!current) throw Object.assign(new Error('This Promo Code reservation expired or is no longer available.'), { status: 409 });
      const purchaseDetails = {
        promo: current,
        reservationId: current.reservationId,
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        paymentMethod: 'Razorpay',
        idempotencyKey: `rzp:${paymentId}`,
        razorpayPaymentId: paymentId,
      };
      const recipient = await resolvePromoRecipient(session, { promo: current, userId: req.session.sub, userEmail: req.session.email, recipientEmail: current.giftRecipientEmail });
      const completed = current.purchaseType === 'offline'
        ? await createOfflinePromoCodeOrder(session, { ...purchaseDetails, address: current.recipientAddress, buyerAddress: current.buyerAddress, recipientAddress: current.recipientAddress, ...recipient, recipientType: current.recipientType })
        : await completePromoCodeOrder(session, purchaseDetails);
      return { ...completed, duplicate: false };
    });
    return res.json({ promoCode: result.promoCode && result.order.recipientType !== 'gift' ? { code: result.promoCode.code, amount: money(result.promoCode.amountPaise) } : null, order: buyerOrderView(result.order), duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) {
      const duplicate = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, razorpayPaymentId: paymentId, status: { $in: ['pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed'] } }).lean();
      if (duplicate) {
        const order = await Order.findOne({ orderId: duplicate.orderId, userId: req.session.sub }).lean();
        return res.json({ promoCode: duplicate.recipientType === 'gift' || duplicate.purchaseType === 'offline' && !duplicate.purchasedBy?.userId ? null : { code: duplicate.code, amount: money(duplicate.amountPaise) }, order: buyerOrderView(order), duplicate: true });
      }
      return res.status(409).json({ message: 'This Promo Code has already been purchased.' });
    }
    throw error;
  }
});

app.get('/api/wallet/promo-codes', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  await expirePromoCodes();
  const promos = await PromoCode.find({
    'purchasedBy.userId': req.session.sub,
    status: { $in: ['purchased', 'expired', 'fully_redeemed', 'used'] },
  }).sort({ activatedAt: -1, purchasedAt: -1 }).lean();
  const promoCodes = promos.map((promo) => ({
    id: promo._id,
    code: promo.code,
    amount: money(promo.amountPaise),
    status: promo.status === 'used' ? 'fully_redeemed' : promo.status,
    activatedAt: promo.activatedAt || null,
    expiresAt: promo.expiresAt || null,
    maxUses: promo.maxUses || (promo.status === 'used' ? 1 : 10),
    successfulUses: promo.successfulUses || (promo.status === 'used' ? promo.maxUses || 1 : 0),
    remainingUses: Math.max(0, (promo.maxUses || (promo.status === 'used' ? 1 : 10)) - (promo.successfulUses || (promo.status === 'used' ? promo.maxUses || 1 : 0))),
    gift: Boolean(promo.giftBuyerId && promo.giftBuyerId !== promo.purchasedBy.userId),
    buyerName: promo.giftBuyerName || null,
    buyerEmail: promo.giftBuyerEmail || null,
    orderId: promo.orderId || null,
  }));
  return res.json({ promoCodes });
});

app.post('/api/wallet/promo/redeem', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code)) return res.status(400).json({ code: 'INVALID_PROMO', message: 'Enter a valid promo code in XXXX-XXXX-XXXX-XXXX format.' });
  await expirePromoCodes();
  try {
    const result = await withMongoTransaction(async (session) => {
      const promo = await PromoCode.findOne({ code }).session(session);
      if (!promo) throw Object.assign(new Error('This promo code is invalid or does not exist.'), { status: 404, code: 'INVALID_PROMO' });
      const now = new Date();
      if (promo.status === 'purchased' && promo.expiresAt && promo.expiresAt <= now) {
        await PromoCode.updateOne({ _id: promo._id, status: 'purchased', expiresAt: { $lte: now } }, { $set: { status: 'expired' } }, { session });
        if (promo.orderId) await Order.updateOne({ orderId: promo.orderId, promoCodeId: promo._id }, { $set: { promoActivationStatus: 'expired', promoCodeStatus: 'EXPIRED' } }, { session });
        return { expired: true };
      }
      if (['used', 'fully_redeemed'].includes(promo.status)) throw Object.assign(new Error('This promo code has reached its maximum successful redemptions.'), { status: 409, code: 'PROMO_USED' });
      if (promo.status === 'expired') throw Object.assign(new Error('This promo code has expired.'), { status: 410, code: 'PROMO_EXPIRED' });
      if (promo.status !== 'purchased' || promo.purchasedBy?.userId !== req.session.sub) {
        throw Object.assign(new Error('Purchase this promo code before redeeming it in your Wallet.'), { status: 409, code: 'PROMO_NOT_PURCHASED' });
      }

      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet) throw Object.assign(new Error('Create your wallet PIN before redeeming a promo code.'), { status: 409, code: 'WALLET_SETUP_REQUIRED' });
      const successfulUses = promo.successfulUses || 0;
      const maxUses = promo.maxUses || 10;
      if (successfulUses >= maxUses) {
        await PromoCode.updateOne({ _id: promo._id, status: 'purchased', successfulUses }, { $set: { status: 'fully_redeemed' } }, { session });
        return { exhausted: true };
      }
      const nextSuccessfulUses = successfulUses + 1;
      const changed = await PromoCode.updateOne(
        {
          _id: promo._id,
          status: 'purchased',
          'purchasedBy.userId': req.session.sub,
          $and: [
            { $or: [{ successfulUses }, { successfulUses: { $exists: false } }] },
            { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] },
          ],
        },
        { $inc: { successfulUses: 1 }, $set: { usedBy: { userId: req.session.sub, name: req.session.name || '', email: req.session.email }, usedAt: now } },
        { session },
      );
      if (!changed.modifiedCount) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'PROMO_USED' });
      const fullyRedeemed = nextSuccessfulUses >= maxUses;
      if (fullyRedeemed) await PromoCode.updateOne({ _id: promo._id, status: 'purchased', successfulUses: nextSuccessfulUses }, { $set: { status: 'fully_redeemed' } }, { session });
      if (promo.orderId) await Order.updateOne({ orderId: promo.orderId, promoCodeId: promo._id, orderType: 'PROMO_CODE' }, { $set: { promoCodeStatus: fullyRedeemed ? 'FULLY_REDEEMED' : 'PARTIALLY_REDEEMED', promoActivationStatus: fullyRedeemed ? 'fully_redeemed' : 'active', promoSuccessfulUses: nextSuccessfulUses, promoMaxUses: maxUses } }, { session });

      const before = wallet.balancePaise;
      wallet.balancePaise += promo.amountPaise;
      await wallet.save({ session });
      const referenceId = `promo:${promo.code}:${nextSuccessfulUses}`;
      const [transaction] = await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Promo Code',
        amountPaise: promo.amountPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        description: `Promo Code: ${promo.code}`,
        status: 'Successful',
      }], { session });
      await Notification.create([{ userId: req.session.sub, message: `A Promo Code redemption added ₹${money(promo.amountPaise).toLocaleString('en-IN')} to your Wallet. ${fullyRedeemed ? 'This code has reached its usage limit.' : `${maxUses - nextSuccessfulUses} uses remain.`}` }], { session });
      return { expired: false, exhausted: false, amountPaise: promo.amountPaise, wallet: wallet.toObject(), transaction: transaction.toObject(), successfulUses: nextSuccessfulUses, remainingUses: Math.max(0, maxUses - nextSuccessfulUses), fullyRedeemed };
    });
    if (result.expired) return res.status(410).json({ code: 'PROMO_EXPIRED', message: 'This promo code has expired.' });
    if (result.exhausted) return res.status(409).json({ code: 'PROMO_USED', message: 'This promo code has reached its maximum successful redemptions.' });
    return res.json({ amount: money(result.amountPaise), balance: money(result.wallet.balancePaise), successfulUses: result.successfulUses, remainingUses: result.remainingUses, fullyRedeemed: result.fullyRedeemed, transaction: walletView(result.wallet, [result.transaction]).transactions[0] });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: error.code, message: error.message });
    throw error;
  }
});

app.post('/api/wallet/pin', requireSession, requireDatabase, async (req, res) => {
  const { pin } = req.body || {};
  if (!validatePin(pin)) return res.status(400).json({ message: 'Wallet PIN must contain exactly 4 digits.' });
  const existing = await Wallet.findOne({ userId: req.session.sub }).lean();
  if (existing?.pinHash) return res.status(409).json({ message: 'A wallet PIN already exists.' });
  if (existing) {
    const updated = await Wallet.updateOne({ userId: req.session.sub, pinHash: '' }, { $set: { pinHash: hashPin(pin) } });
    if (!updated.modifiedCount) return res.status(409).json({ message: 'A wallet PIN already exists.' });
  }
  else await Wallet.create({ userId: req.session.sub, pinHash: hashPin(pin), balancePaise: 0 });
  issueWalletUnlock(res, req.session);
  return res.status(201).json({ created: true });
});

app.post('/api/wallet/unlock', requireSession, requireDatabase, async (req, res) => {
  const { pin } = req.body || {};
  const wallet = await Wallet.findOne({ userId: req.session.sub });
  if (!wallet) return res.status(409).json({ message: 'Create your wallet PIN first.' });
  if (wallet.lockedUntil && wallet.lockedUntil > new Date()) return res.status(429).json({ message: 'Wallet is temporarily locked. Please try again later.' });
  if (!validatePin(pin) || !verifyPin(pin, wallet.pinHash)) {
    wallet.failedPinAttempts += 1;
    if (wallet.failedPinAttempts >= 5) {
      wallet.failedPinAttempts = 0;
      wallet.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
    }
    await wallet.save();
    return res.status(401).json({ message: 'Incorrect PIN. Please try again.' });
  }
  wallet.failedPinAttempts = 0;
  wallet.lockedUntil = undefined;
  await wallet.save();
  const transactions = await WalletTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean();
  issueWalletUnlock(res, req.session);
  return res.json({ wallet: walletView(wallet.toObject(), transactions) });
});

app.post('/api/wallet/recharge/order', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const amountPaise = Number(req.body?.amountPaise);
  if (!Number.isInteger(amountPaise) || amountPaise < 1000) return res.status(400).json({ message: 'Minimum wallet recharge is ₹10.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Wallet payments are not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the server environment.' });
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: `wallet-${req.session.sub}-${Date.now()}` }),
    });
    const order = await response.json();
    if (!response.ok) return res.status(502).json({ message: 'Razorpay could not create the recharge order.' });
    return res.json({ orderId: order.id, keyId: razorpayKeyId, amountPaise });
  } catch {
    return res.status(503).json({ message: 'Recharge service is temporarily unavailable.' });
  }
});

app.post('/api/wallet/recharge/verify', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const body = req.body || {};
  const razorpayPaymentId = body.razorpayPaymentId || body.razorpay_payment_id;
  const razorpayOrderId = body.razorpayOrderId || body.razorpay_order_id;
  const razorpaySignature = body.razorpaySignature || body.razorpay_signature;
  const { amountPaise } = body;
  const requestedPaise = Number(amountPaise);
  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature || !Number.isInteger(requestedPaise) || requestedPaise < 1000) {
    return res.status(400).json({ message: 'A valid recharge payment verification is required.' });
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Wallet payments are not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the server environment.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
  if (expectedSignature !== razorpaySignature) return res.status(401).json({ message: 'Recharge payment verification failed.' });
  try {
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpayPaymentId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
    });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.amount !== requestedPaise || payment.order_id !== razorpayOrderId || payment.status !== 'captured') {
      return res.status(409).json({ message: 'Recharge payment amount or status could not be verified.' });
    }
  } catch {
    return res.status(503).json({ message: 'Recharge verification is temporarily unavailable.' });
  }

  const referenceId = `recharge:${razorpayPaymentId}`;
  const result = await withMongoTransaction(async (session) => {
    const existing = await WalletTransaction.findOne({ referenceId }).session(session).lean();
    if (existing) return { duplicate: true, wallet: await Wallet.findOne({ userId: req.session.sub }).session(session).lean() };
    const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
    if (!wallet) throw Object.assign(new Error('Create and unlock your wallet before recharging.'), { status: 409 });
    const before = wallet.balancePaise;
    wallet.balancePaise += requestedPaise;
    await wallet.save({ session });
    await WalletTransaction.create([{ userId: req.session.sub, type: 'Recharge', amountPaise: requestedPaise, balanceBeforePaise: before, balanceAfterPaise: wallet.balancePaise, referenceId, description: 'Wallet recharge', status: 'Successful' }], { session });
    await createInvoiceForStandalonePurchase(session, { userId: req.session.sub, orderId: referenceId, paymentId: razorpayPaymentId, paymentMethod: 'Razorpay', itemName: 'Wallet Recharge', amountPaise: requestedPaise });
    return { duplicate: false, wallet: wallet.toObject() };
  });
  return res.json({ duplicate: result.duplicate, wallet: walletView(result.wallet) });
});

app.post('/api/wallet/pay', requireSession, requireDatabase, async (req, res) => {
  const { items, address, service = 'parts', projectDescription = '', pin, idempotencyKey, discountCode } = req.body || {};
  if (!validatePin(pin) || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'Wallet PIN and a valid payment reference are required.' });
  if (!['parts', 'coding', 'building', 'full'].includes(service)) return res.status(400).json({ message: 'Choose a valid project service.' });
  const { safeItems, customOrders } = await resolveOrderItems(items, req.session.sub);
  const deliveryRequired = orderRequiresDelivery(safeItems);
  if (deliveryRequired && !validateAddress(address)) return res.status(400).json({ message: 'Complete the required delivery address fields.' });
  const calculated = calculateOrder(safeItems, service);
  const orderId = `IL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  try {
    const result = await withMongoTransaction(async (session) => {
      const duplicate = await WalletTransaction.findOne({ userId: req.session.sub, referenceId: `wallet-payment:${idempotencyKey}` }).session(session).lean();
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      await enforceOrderLimit(session);
      if (!wallet || !verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect PIN. Please try again.'), { status: 401 });
      if (duplicate) {
        const existingOrder = await Order.findOne({ orderId: duplicate.orderId, userId: req.session.sub }).session(session).lean();
        if (!existingOrder) throw Object.assign(new Error('This wallet payment has already been processed.'), { status: 409 });
        return { order: existingOrder, wallet: wallet.toObject(), duplicate: true };
      }
      const discount = discountCode ? await discountCodeContext({ session, userId: req.session.sub, code: discountCode, items: safeItems }) : null;
      const discountAmountPaise = discount?.discountAmountPaise || 0;
      const totalPaise = Math.max(0, calculated.totalPaise - discountAmountPaise);
      if (wallet.balancePaise < totalPaise) throw Object.assign(new Error('Insufficient wallet balance.'), { status: 402, balance: money(wallet.balancePaise), required: money(totalPaise) });
      const inventoryDeductedAt = await applyInventoryReduction(session, safeItems);
      const before = wallet.balancePaise;
      wallet.balancePaise -= totalPaise;
      await wallet.save({ session });
      const [order] = await Order.create([{
        orderId,
        orderType: safeItems.every((item) => item.discountOfferId) ? 'DISCOUNT_CODE' : 'PRODUCT',
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        items: safeItems,
        address: deliveryRequired ? address : null,
        deliveryRequired,
        service,
        projectDescription: String(projectDescription).slice(0, 2000),
        subtotal: money(calculated.subtotalPaise),
        discountAmountPaise,
        discountCode: discount?.code || '',
        codingCharge: money(calculated.codingChargePaise),
        buildingCharge: money(calculated.buildingChargePaise),
        deliveryCharge: money(calculated.deliveryChargePaise),
        total: money(totalPaise),
        paymentStatus: 'Paid',
        paymentMethod: 'Wallet',
        walletBalanceAfterPaise: wallet.balancePaise,
        inventoryDeductedAt,
        orderStatus: 'Processing',
        statusHistory: [{ status: 'Processing', note: 'Order paid from wallet', createdAt: new Date() }],
      }], { session });
      const discountCodes = await fulfillDiscountOfferItems(session, safeItems, { userId: req.session.sub, orderId });
      if (discount) await redeemDiscountCode(session, { userId: req.session.sub, code: discount.code, items: safeItems, orderId });
      await awardRewardPointsForOrder(session, order);
      await WalletTransaction.create([{ userId: req.session.sub, type: 'Purchase', amountPaise: -totalPaise, balanceBeforePaise: before, balanceAfterPaise: wallet.balancePaise, referenceId: `wallet-payment:${idempotencyKey}`, orderId, description: `Purchase ${orderId}`, status: 'Successful' }], { session });
      await createInvoiceForOrder(session, order);
      await createScratchCardForOrder(session, order);
      if (customOrders.length) await CustomOrder.updateMany({ _id: { $in: customOrders.map((item) => item._id) }, userId: req.session.sub, status: 'Accepted' }, { $set: { status: 'Ordered', orderedAt: new Date() } }, { session });
      await Notification.create([{ userId: req.session.sub, message: `Order ${orderId} was paid from your wallet.` }], { session });
      return { order, discountCodes, wallet: wallet.toObject() };
    });
    const savedOrder = result.order.toObject ? result.order.toObject() : result.order;
    const discountCodes = result.discountCodes || await discountCodesForOrder(savedOrder.orderId);
    const cancellation = cancellationEligibilityFor(savedOrder, Boolean(discountCodes.length));
    const refund = refundEligibilityFor(savedOrder, null);
    const order = {
      ...savedOrder,
      discountCodes,
      cancelEligible: cancellation.eligible,
      cancellationEligibility: { eligible: cancellation.eligible, reason: cancellation.reason },
      refundEligible: refund.eligible,
      refundEligibility: { eligible: refund.eligible, reason: refund.reason, deliveredAt: refund.deliveredAt, eligibleAt: refund.eligibleAt },
      refundCase: null,
    };
    return res.status(result.duplicate ? 200 : 201).json({ order, wallet: walletView(result.wallet), duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message, balance: error.balance, required: error.required });
    throw error;
  }
});

app.get('/api/refunds', requireSession, requireDatabase, async (req, res) => {
  const refunds = await Refund.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean();
  return res.json({ refunds });
});

app.get('/api/refunds/eligibility/:orderId', requireSession, requireDatabase, async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.orderId, userId: req.session.sub }).lean();
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  const existing = await Refund.findOne({ orderId: order.orderId }).lean();
  const eligibility = refundEligibilityFor(order, existing);
  return res.json({
    eligibility: { eligible: eligibility.eligible, reason: eligibility.reason, deliveredAt: eligibility.deliveredAt, eligibleAt: eligibility.eligibleAt },
    refund: existing ? { _id: existing._id, refundCaseId: existing.refundCaseId, status: existing.status, refundAmountPaise: existing.refundAmountPaise } : null,
    order: {
      orderId: order.orderId,
      userName: order.userName,
      userEmail: order.userEmail,
      createdAt: order.createdAt,
      deliveredAt: eligibility.deliveredAt,
      items: order.items,
      total: order.total,
      paymentMethod: order.paymentMethod,
      address: order.address,
    },
  });
});

app.post('/api/refunds', requireSession, requireDatabase, refundEvidenceUpload, async (req, res) => {
  const { orderId, reason = '', reasonCategory = 'Other' } = req.body || {};
  if (typeof orderId !== 'string' || !orderId.trim()) return res.status(400).json({ message: 'An order ID is required.' });
  if (!req.file) return res.status(400).json({ message: 'Upload a photo of the item as refund evidence.' });
  const detectedContentType = identifyRefundImage(req.file.buffer);
  if (!detectedContentType || detectedContentType !== req.file.mimetype) {
    return res.status(400).json({ message: 'The uploaded file is not a valid JPEG, PNG, or WebP image.' });
  }
  const validReasons = ['Damaged item', 'Wrong item received', 'Item does not match order', 'Product issue', 'Other'];
  const normalizedReason = String(reason).trim().slice(0, 1000);
  if (!validReasons.includes(reasonCategory)) return res.status(400).json({ message: 'Choose a valid refund reason.' });
  if (!normalizedReason || (reasonCategory === 'Other' && normalizedReason.length < 10)) {
    return res.status(400).json({ message: 'Please describe the refund issue. Other reasons need at least 10 characters.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const order = await Order.findOne({ orderId: orderId.trim(), userId: req.session.sub }).session(session).lean();
      if (!order) throw Object.assign(new Error('Order was not found.'), { status: 404 });
      const existing = await Refund.findOne({ orderId: order.orderId }).session(session).lean();
      const eligibility = refundEligibilityFor(order, existing);
      if (!eligibility.eligible) throw Object.assign(new Error(eligibility.reason), { status: 409, refund: existing });
      if (order.paymentStatus !== 'Paid') throw Object.assign(new Error('Only paid orders can be refunded.'), { status: 409 });
      const originalOrderAmountPaise = toPaise(order.total);
      if (!Number.isSafeInteger(originalOrderAmountPaise) || originalOrderAmountPaise <= 0) {
        throw Object.assign(new Error('The order does not have an eligible paid amount.'), { status: 409 });
      }
      const refundCaseId = `RF-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const claimedOrder = await Order.updateOne(
        { orderId: order.orderId, userId: req.session.sub, refundCaseId: null },
        { $set: { refundCaseId } },
        { session },
      );
      if (!claimedOrder.modifiedCount) throw Object.assign(new Error('A refund case already exists for this order.'), { status: 409 });
      const evidenceFileName = String(req.file.originalname || 'evidence').replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
      const [refund] = await Refund.create([{
        refundCaseId,
        orderId: order.orderId,
        userId: req.session.sub,
        userName: order.userName,
        userEmail: order.userEmail,
        originalOrderAmountPaise,
        calculatedRefundAmountPaise: originalOrderAmountPaise,
        approvedRefundAmountPaise: originalOrderAmountPaise,
        refundAmountPaise: originalOrderAmountPaise,
        itemsSnapshot: order.items.map(({ id, name, category, price, quantity }) => ({ id, name, category, price, quantity })),
        orderSnapshot: {
          createdAt: order.createdAt,
          deliveredAt: eligibility.deliveredAt,
          total: order.total,
          subtotal: order.subtotal,
          deliveryCharge: order.deliveryCharge,
          codingCharge: order.codingCharge,
          buildingCharge: order.buildingCharge,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          address: order.address,
        },
        reason: normalizedReason,
        reasonCategory,
        evidence: { fileName: evidenceFileName, contentType: detectedContentType, size: req.file.size, data: req.file.buffer },
        status: 'REFUND_PLACED',
        statusHistory: [{ status: 'REFUND_PLACED', changedBy: req.session.sub, note: 'Refund request submitted.', createdAt: new Date() }],
      }], { session });
      await Notification.create([{ userId: req.session.sub, message: `Refund request ${refundCaseId} has been received.` }], { session });
      return refund;
    });
    const createdRefund = result.toObject();
    if (createdRefund.evidence) delete createdRefund.evidence.data;
    return res.status(201).json({ refund: createdRefund });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message, refund: error.refund ? { _id: error.refund._id, refundCaseId: error.refund.refundCaseId, status: error.refund.status } : undefined });
    if (error.code === 11000) return res.status(409).json({ message: 'A refund case already exists for this order.' });
    throw error;
  }
});

app.get('/api/refunds/:id/evidence', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Refund evidence was not found.' });
  const refund = await Refund.findById(req.params.id).select('+evidence.data').lean();
  if (!refund?.evidence?.data) return res.status(404).json({ message: 'Refund evidence was not found.' });
  const isOwner = refund.userId === req.session.sub;
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  if (!isOwner && !isAdmin) return res.sendStatus(403);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `inline; filename="${refund.evidence.fileName || 'refund-evidence'}"`);
  return res.type(refund.evidence.contentType).send(refund.evidence.data);
});

app.get('/api/refunds/:id', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Refund case was not found.' });
  const refund = await Refund.findOne({ _id: req.params.id, userId: req.session.sub }).lean();
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  return res.json({ refund });
});

app.get('/api/admin/refunds', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const refunds = await Refund.find().sort({ createdAt: -1 }).lean();
  return res.json({ refunds });
});

app.get('/api/admin/refunds/:id', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Refund case was not found.' });
  const refund = await Refund.findById(req.params.id).lean();
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  const order = await Order.findOne({ orderId: refund.orderId, userId: refund.userId }).lean();
  return res.json({ refund, order: order ? { ...order, items: refund.itemsSnapshot?.length ? refund.itemsSnapshot : order.items } : null });
});

app.patch('/api/admin/refunds/:id/status', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const { action, reason = '' } = req.body || {};
  const refund = await Refund.findOne({ _id: req.params.id });
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  const transitions = {
    check: { from: 'REFUND_PLACED', to: 'ORDER_CHECKING', note: 'Order check started.' },
    return: { from: 'ORDER_CHECKING', to: 'RETURN_REQUIRED', note: 'Return or collection is required.' },
    arrived: { from: 'RETURN_REQUIRED', to: 'PACKAGE_ARRIVED', note: 'Returned package received.' },
    inspect: { from: 'PACKAGE_ARRIVED', to: 'PART_CHECKING', note: 'Item inspection started.' },
    accept: { from: 'PART_CHECKING', to: 'ORDER_ACCEPTED', note: 'Returned item passed inspection; refund accepted.' },
    process: { from: 'ORDER_ACCEPTED', to: 'REFUND_PROCESSING', note: 'Refund processing started.' },
    initiate: { from: 'REFUND_PROCESSING', to: 'REFUND_INITIATED', note: 'Refund initialized; wallet credit is pending.' },
  };
  if (action === 'decline' && refund.status === 'PART_CHECKING') {
    const declineReason = String(reason).trim().slice(0, 1000);
    if (!declineReason) return res.status(400).json({ message: 'A reason is required to decline a refund.' });
    refund.adminReason = declineReason;
    setRefundStatus(refund, 'ORDER_DECLINED', req.session.email, declineReason, 'refund_declined');
    setRefundStatus(refund, 'REFUND_REJECTED', req.session.email, declineReason, 'refund_declined');
  } else {
    const transition = transitions[action];
    if (!transition || refund.status !== transition.from) return res.status(409).json({ message: 'This refund cannot move to that stage.' });
    setRefundStatus(refund, transition.to, req.session.email, transition.note, action);
  }
  await refund.save();
  const notifications = {
    ORDER_CHECKING: 'Your refund request is being reviewed.',
    RETURN_REQUIRED: 'Please keep the ordered item ready at the delivery address for return or collection instructions.',
    PACKAGE_ARRIVED: 'Your returned package has been received.',
    PART_CHECKING: 'Your returned item is being inspected against the original order.',
    ORDER_ACCEPTED: 'Your refund has been accepted.',
    ORDER_DECLINED: `Your refund was declined. Reason: ${refund.adminReason}`,
    REFUND_PROCESSING: 'Your accepted refund is being processed.',
    REFUND_INITIATED: 'Your refund has been initialized and is expected to be credited within 3–5 business days.',
  };
  await Notification.create({ userId: refund.userId, message: notifications[refund.status] || `Refund ${refund.refundCaseId} status changed.` });
  return res.json({ refund });
});

app.patch('/api/admin/refunds/:id/amount', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const refund = await Refund.findById(req.params.id);
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  if (refund.status !== 'ORDER_ACCEPTED') return res.status(409).json({ message: 'The approved amount can only be changed after inspection and before processing.' });
  const amountPaise = Number(req.body?.amountPaise);
  const maximum = refund.calculatedRefundAmountPaise ?? refund.refundAmountPaise;
  const original = refund.originalOrderAmountPaise ?? maximum;
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > maximum || amountPaise > original) {
    return res.status(400).json({ message: 'Approved refund must be a positive amount no greater than the eligible refund.' });
  }
  const previousAmount = refund.approvedRefundAmountPaise ?? refund.refundAmountPaise;
  refund.approvedRefundAmountPaise = amountPaise;
  refund.refundAmountPaise = amountPaise;
  refund.adminAudit.push({ adminId: req.session.email, action: 'refund_amount_changed', timestamp: new Date(), oldStatus: refund.status, newStatus: refund.status, amountPaise, reason: `Changed from ${money(previousAmount)} to ${money(amountPaise)}.` });
  refund.statusHistory.push({ status: refund.status, changedBy: req.session.email, note: `Approved refund amount set to ₹${money(amountPaise).toLocaleString('en-IN')}.`, createdAt: new Date() });
  await refund.save();
  return res.json({ refund });
});

app.post('/api/admin/refunds/:id/initiate', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const refund = await Refund.findById(req.params.id);
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  if (refund.status !== 'REFUND_PROCESSING') return res.status(409).json({ message: 'This refund is not ready to initialize.' });
  setRefundStatus(refund, 'REFUND_INITIATED', req.session.email, 'Refund initialized; expected wallet credit within 3–5 business days.', 'refund_initiated');
  await refund.save();
  await Notification.create({ userId: refund.userId, message: 'Your refund has been initialized and is expected to be credited within 3–5 business days.' });
  return res.json({ refund });
});

app.post('/api/admin/refunds/:id/credit', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  try {
    const result = await withMongoTransaction(async (session) => {
      const refund = await Refund.findById(req.params.id).session(session);
      if (!refund) throw Object.assign(new Error('Refund case was not found.'), { status: 404 });
      if (['REFUND_CREDITED', 'REFUND_COMPLETED'].includes(refund.status)) return { refund: refund.toObject(), duplicate: true };
      if (refund.status !== 'REFUND_INITIATED') throw Object.assign(new Error('Only an initialized refund can be credited.'), { status: 409 });
      const approvedAmount = refund.approvedRefundAmountPaise ?? refund.refundAmountPaise;
      const maximum = refund.calculatedRefundAmountPaise ?? refund.originalOrderAmountPaise ?? approvedAmount;
      if (!Number.isSafeInteger(approvedAmount) || approvedAmount <= 0 || approvedAmount > maximum || approvedAmount > (refund.originalOrderAmountPaise ?? maximum)) {
        throw Object.assign(new Error('The approved refund amount is not valid.'), { status: 409 });
      }
      const referenceId = `refund:${refund.refundCaseId}`;
      const existingTransaction = await WalletTransaction.findOne({ referenceId }).session(session);
      if (existingTransaction) throw Object.assign(new Error('This refund has already been credited.'), { status: 409 });
      const wallet = await Wallet.findOne({ userId: refund.userId }).session(session);
      if (!wallet) throw Object.assign(new Error('The customer has not created a wallet.'), { status: 409 });
      const before = wallet.balancePaise;
      wallet.balancePaise += approvedAmount;
      await wallet.save({ session });
      const [transaction] = await WalletTransaction.create([{
        userId: refund.userId,
        type: 'Refund',
        amountPaise: approvedAmount,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        orderId: refund.orderId,
        refundCaseId: refund.refundCaseId,
        description: `Refund ${refund.refundCaseId} for order ${refund.orderId}`,
        status: 'Completed',
      }], { session });
      refund.walletTransactionId = transaction._id;
      setRefundStatus(refund, 'REFUND_CREDITED', req.session.email, 'Refund credited to the customer wallet.', 'refund_credited');
      setRefundStatus(refund, 'REFUND_COMPLETED', req.session.email, 'Refund completed.', 'refund_completed');
      await refund.save({ session });
      const refundedOrder = await Order.findOne({ orderId: refund.orderId, userId: refund.userId }).session(session).lean();
      if (refundedOrder) {
        await reverseRewardPointsForOrder(session, refundedOrder, { referenceId, refundAmountPaise: approvedAmount });
        await releaseDiscountRedemptionForOrder(session, refundedOrder.orderId);
        await createCreditNoteForRefund(session, { userId: refund.userId, orderId: refund.orderId, refundCaseId: refund.refundCaseId, amountPaise: approvedAmount, reason: `Refund ${refund.refundCaseId}` });
      }
      await Notification.create([{ userId: refund.userId, message: `${money(approvedAmount).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })} has been credited to your Innovation Labs Wallet for refund ${refund.refundCaseId}.` }], { session });
      return { refund: refund.toObject(), balance: wallet.balancePaise, duplicate: false };
    });
    return res.json({ refund: result.refund, wallet: result.balance == null ? undefined : { balance: money(result.balance) }, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This refund has already been credited.' });
    throw error;
  }
});

app.get('/api/scratch-cards', requireSession, requireDatabase, async (req, res) => {
  const cards = await ScratchCard.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean();
  const purchases = await PurchasedDiscountCode.find({ purchaseId: { $in: cards.map((card) => card.discountPurchaseId) } }).lean();
  const purchasesById = new Map(purchases.map((purchase) => [purchase.purchaseId, purchase]));
  return res.json({ scratchCards: cards.map((card) => {
    const reward = purchasesById.get(card.discountPurchaseId);
    const revealed = card.status !== 'issued' && reward?.fulfillmentStatus === 'fulfilled';
    return {
      scratchCardId: card.scratchCardId,
      orderId: card.orderId,
      eligibleOrderAmount: money(card.eligibleOrderAmountPaise),
      rewardValue: money(card.rewardValuePaise),
      rewardType: reward?.discountType || 'fixed',
      status: card.status,
      createdAt: card.createdAt,
      revealedAt: card.revealedAt || null,
      code: revealed ? reward.code : null,
    };
  }) });
});

app.post('/api/scratch-cards/:scratchCardId/reveal', requireSession, requireDatabase, async (req, res) => {
  try {
    const result = await withMongoTransaction(async (session) => {
      const card = await ScratchCard.findOne({ scratchCardId: req.params.scratchCardId, userId: req.session.sub }).session(session);
      if (!card) throw Object.assign(new Error('Scratch card was not found.'), { status: 404 });
      if (card.status === 'reversed') throw Object.assign(new Error('This scratch card is no longer valid.'), { status: 409 });
      const purchase = await PurchasedDiscountCode.findOne({ purchaseId: card.discountPurchaseId, userId: req.session.sub }).session(session);
      if (!purchase || !purchase.isScratchReward) throw Object.assign(new Error('Scratch card reward could not be verified.'), { status: 409 });
      if (card.status === 'issued') {
        if (purchase.expiresAt <= new Date()) throw Object.assign(new Error('This scratch card reward has expired.'), { status: 410 });
        card.status = 'scratched';
        card.revealedAt = new Date();
        purchase.fulfillmentStatus = 'fulfilled';
        await card.save({ session });
        await purchase.save({ session });
        const rewardLabel = purchase.discountType === 'percentage' ? `${purchase.discountPercent}% off` : `₹${money(card.rewardValuePaise)} off`;
        await Notification.create([{ userId: req.session.sub, type: 'scratch_card_revealed', data: { scratchCardId: card.scratchCardId, code: purchase.code }, message: `Scratch card revealed: ${purchase.code} gives ${rewardLabel}.` }], { session });
      }
      return { card: card.toObject(), purchase: purchase.toObject() };
    });
    return res.json({ scratchCard: {
      scratchCardId: result.card.scratchCardId,
      orderId: result.card.orderId,
      rewardValue: money(result.card.rewardValuePaise),
      rewardType: result.purchase.discountType,
      status: result.card.status,
      revealedAt: result.card.revealedAt,
      code: result.purchase.code,
    } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

app.get('/api/invoices', requireSession, requireDatabase, async (req, res) => {
  const invoices = await Invoice.find({ userId: req.session.sub }).sort({ createdAt: -1 }).select('-pdfData').lean();
  return res.json({ invoices });
});

app.get('/api/invoices/:invoiceId/download', requireSession, requireDatabase, async (req, res) => {
  const invoice = await Invoice.findOne({ userId: req.session.sub, $or: [{ invoiceId: req.params.invoiceId }, { invoiceNumber: req.params.invoiceId }] }).select('+pdfData');
  if (!invoice?.pdfData) return res.status(404).json({ message: 'Invoice PDF was not found.' });
  if (!Buffer.isBuffer(invoice.pdfData) || invoice.pdfData.length < 5 || invoice.pdfData.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return res.status(500).json({ message: 'The stored invoice PDF is invalid.' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  return res.send(invoice.pdfData);
});

app.get('/api/account', requireSession, requireDatabase, async (req, res) => {
  const [user, orders, customOrders, notifications, refunds] = await Promise.all([
    User.findOne({ googleId: req.session.sub }).lean(),
    Order.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean(),
    CustomOrder.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean(),
    Notification.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean(),
    Refund.find({ userId: req.session.sub }).select('orderId refundCaseId status refundAmountPaise approvedRefundAmountPaise reasonCategory walletTransactionReferenceId').lean(),
  ]);
  const discountOrderIds = orders.filter((order) => order.orderType === 'DISCOUNT_CODE').map((order) => order.orderId);
  const discountPurchases = discountOrderIds.length
    ? await PurchasedDiscountCode.find({ orderId: { $in: discountOrderIds } }).select('orderId offerId fulfillmentStatus redemptionCount').lean()
    : [];
  const discountPurchasesByOrder = new Map();
  for (const purchase of discountPurchases) {
    const purchases = discountPurchasesByOrder.get(purchase.orderId) || [];
    purchases.push(purchase);
    discountPurchasesByOrder.set(purchase.orderId, purchases);
  }
  const refundsByOrder = new Map(refunds.map((refund) => [refund.orderId, refund]));
  const ordersWithRefundEligibility = orders.map((order) => {
    const refund = refundsByOrder.get(order.orderId) || null;
    const eligibility = refundEligibilityFor(order, refund);
    const hasUnusedDiscountCodePurchases = orderDiscountCodePurchasesAreUnused(order, discountPurchasesByOrder.get(order.orderId) || []);
    const cancellation = cancellationEligibilityFor(order, hasUnusedDiscountCodePurchases);
    return {
      ...buyerOrderView(order),
      cancelEligible: cancellation.eligible,
      cancellationEligibility: { eligible: cancellation.eligible, reason: cancellation.reason },
      refundEligible: eligibility.eligible,
      refundEligibility: { eligible: eligibility.eligible, reason: eligibility.reason, deliveredAt: eligibility.deliveredAt, eligibleAt: eligibility.eligibleAt },
      refundCase: refund ? { _id: refund._id, refundCaseId: refund.refundCaseId, status: refund.status, refundAmountPaise: refund.refundAmountPaise, approvedRefundAmountPaise: refund.approvedRefundAmountPaise, reasonCategory: refund.reasonCategory, walletTransactionReferenceId: refund.walletTransactionReferenceId } : null,
    };
  });
  const totalItemsOrdered = orders.reduce((sum, order) =>
    sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
  const totalSpent = orders.reduce((sum, order) => sum + order.total, 0);

  return res.json({
    profile: {
      id: req.session.sub,
      name: user?.name || req.session.name,
      email: user?.email || req.session.email,
      picture: user?.picture || null,
      phoneNumber: user?.phoneNumber || '',
      address: user?.address || null,
      recipientAddresses: user?.recipientAddresses || [],
    },
    orders: ordersWithRefundEligibility,
    customOrders,
    notifications,
    stats: {
      totalOrders: orders.length,
      totalItemsOrdered,
      totalSpent,
      customOrderCount: customOrders.length,
    },
  });
});

app.get('/api/rewards', requireSession, requireDatabase, async (req, res) => {
  const [account, transactions] = await Promise.all([
    RewardAccount.findOneAndUpdate(
      { userId: req.session.sub },
      { $setOnInsert: { userId: req.session.sub } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ),
    RewardTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(250).lean(),
  ]);
  return res.json({
    account: {
      availablePoints: Math.max(0, account.availablePoints),
      lifetimePointsEarned: account.lifetimePointsEarned,
      lifetimePointsRedeemed: account.lifetimePointsRedeemed,
    },
    transactions,
  });
});

app.post('/api/rewards/convert', requireSession, requireDatabase, async (req, res) => {
  const pointsToConvert = Number(req.body?.pointsToConvert);
  const idempotencyKey = req.body?.idempotencyKey;
  const conversionType = req.body?.conversionType || 'wallet';
  if (!Number.isSafeInteger(pointsToConvert) || pointsToConvert < 100 || pointsToConvert % 100 !== 0 || pointsToConvert > 100000000 || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) {
    return res.status(400).json({ message: 'Choose a valid conversion in multiples of 100 points.' });
  }
  if (!['wallet', 'discount-code'].includes(conversionType)) return res.status(400).json({ message: 'Choose a valid reward conversion type.' });
  const transactionId = `${conversionType === 'discount-code' ? 'discount-code' : 'convert'}:${idempotencyKey}`;
  try {
    const result = await withMongoTransaction(async (session) => {
      const previous = await RewardTransaction.findOne({ transactionId, userId: req.session.sub }).session(session).lean();
      if (previous) {
        const account = await RewardAccount.findOne({ userId: req.session.sub }).session(session).lean();
        if (conversionType === 'discount-code') {
          const scratchCard = await ScratchCard.findOne({ userId: req.session.sub, orderId: `REWARD-${transactionId}` }).session(session).lean();
          return { previous, account, scratchCard, duplicate: true };
        }
        const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session).lean();
        return { previous, account, wallet, duplicate: true };
      }
      const account = await RewardAccount.findOneAndUpdate(
        { userId: req.session.sub, availablePoints: { $gte: pointsToConvert } },
        { $inc: { availablePoints: -pointsToConvert, lifetimePointsRedeemed: pointsToConvert } },
        { new: true, session },
      );
      if (!account) throw Object.assign(new Error('You need at least 100 available points and cannot convert more than your balance.'), { status: 409 });
      if (conversionType === 'discount-code') {
        const settings = await ScratchSettings.findOne({ key: 'default' }).session(session).lean() || defaultScratchSettings;
        const scratchCard = await createScratchCardReward(session, {
          userId: req.session.sub,
          orderId: `REWARD-${transactionId}`,
          eligibleOrderAmountPaise: 0,
          rewardValue: pointsToConvert * 100,
          rewardType: 'fixed',
          settings,
        });
        const [transaction] = await RewardTransaction.create([{
          transactionId,
          userId: req.session.sub,
          userEmail: req.session.email,
          transactionType: 'redeemed',
          productType: 'Scratch Card Discount Code',
          eligibleAmountPaise: 0,
          points: pointsToConvert,
          walletAmountPaise: 0,
          status: 'redeemed',
        }], { session });
        return { previous: transaction.toObject(), account: account.toObject(), scratchCard, duplicate: false };
      }
      const walletAmountPaise = pointsToConvert * 100;
      const wallet = await Wallet.findOneAndUpdate(
        { userId: req.session.sub },
        { $setOnInsert: { userId: req.session.sub }, $inc: { balancePaise: walletAmountPaise } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      );
      const balanceBeforePaise = wallet.balancePaise - walletAmountPaise;
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Reward Points',
        amountPaise: walletAmountPaise,
        balanceBeforePaise,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: `reward-wallet:${idempotencyKey}`,
        description: `Converted ${pointsToConvert} reward points to Wallet money`,
        status: 'Successful',
      }], { session });
      const [transaction] = await RewardTransaction.create([{
        transactionId,
        userId: req.session.sub,
        userEmail: req.session.email,
        transactionType: 'redeemed',
        productType: 'Wallet conversion',
        eligibleAmountPaise: 0,
        points: pointsToConvert,
        walletAmountPaise,
        status: 'redeemed',
      }], { session });
      return { previous: transaction.toObject(), account: account.toObject(), wallet: wallet.toObject(), duplicate: false };
    });
    return res.json({
      transaction: result.previous,
      account: {
        availablePoints: Math.max(0, result.account?.availablePoints || 0),
        lifetimePointsEarned: result.account?.lifetimePointsEarned || 0,
        lifetimePointsRedeemed: result.account?.lifetimePointsRedeemed || 0,
      },
      ...(conversionType === 'discount-code' ? { scratchCard: result.scratchCard ? {
        scratchCardId: result.scratchCard.scratchCardId,
        rewardValue: money(result.scratchCard.rewardValuePaise),
        rewardType: result.scratchCard.rewardType,
        status: result.scratchCard.status,
      } : null } : { wallet: { balance: money(result.wallet?.balancePaise || 0) } }),
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) {
      const previous = await RewardTransaction.findOne({ transactionId, userId: req.session.sub }).lean();
      if (previous) {
        const account = await RewardAccount.findOne({ userId: req.session.sub }).lean();
        if (conversionType === 'discount-code') {
          const scratchCard = await ScratchCard.findOne({ userId: req.session.sub, orderId: `REWARD-${transactionId}` }).lean();
          return res.json({
            transaction: previous,
            account: {
              availablePoints: Math.max(0, account?.availablePoints || 0),
              lifetimePointsEarned: account?.lifetimePointsEarned || 0,
              lifetimePointsRedeemed: account?.lifetimePointsRedeemed || 0,
            },
            scratchCard: scratchCard ? {
              scratchCardId: scratchCard.scratchCardId,
              rewardValue: money(scratchCard.rewardValuePaise),
              rewardType: scratchCard.rewardType,
              status: scratchCard.status,
            } : null,
            duplicate: true,
          });
        }
        const wallet = await Wallet.findOne({ userId: req.session.sub }).lean();
        return res.json({
          transaction: previous,
          account: {
            availablePoints: Math.max(0, account?.availablePoints || 0),
            lifetimePointsEarned: account?.lifetimePointsEarned || 0,
            lifetimePointsRedeemed: account?.lifetimePointsRedeemed || 0,
          },
          wallet: { balance: money(wallet?.balancePaise || 0) },
          duplicate: true,
        });
      }
      return res.status(409).json({ message: 'This reward conversion has already been processed.' });
    }
    throw error;
  }
});

app.put('/api/account/address', requireSession, requireDatabase, async (req, res) => {
  const address = req.body?.address;
  if (!validateAddress(address)) {
    return res.status(400).json({ message: 'Complete the required delivery address fields.' });
  }
  const user = await User.findOneAndUpdate(
    { googleId: req.session.sub },
    { $set: { address } },
    { new: true },
  ).lean();
  if (!user) return res.sendStatus(404);
  return res.json({ address: user.address });
});

app.post('/api/account/recipient-addresses', requireSession, requireDatabase, async (req, res) => {
  const address = req.body?.address;
  if (!validateAddress(address)) {
    return res.status(400).json({ message: 'Complete the required recipient address fields.' });
  }
  const fields = ['fullName', 'phoneNumber', 'addressLine1', 'addressLine2', 'city', 'state', 'pinCode', 'country', 'deliveryInstructions'];
  const recipientAddress = Object.fromEntries(fields
    .filter((field) => typeof address[field] === 'string')
    .map((field) => [field, address[field].trim().slice(0, field === 'deliveryInstructions' ? 500 : 200)]));
  const user = await User.findOne({ googleId: req.session.sub });
  if (!user) return res.sendStatus(404);
  const identity = (value) => fields.map((field) => String(value?.[field] || '').trim().toLowerCase()).join('\u0000');
  const existing = user.recipientAddresses || [];
  const addressIndex = existing.findIndex((saved) => identity(saved) === identity(recipientAddress));
  if (addressIndex >= 0) {
    existing.splice(addressIndex, 1);
  }
  user.recipientAddresses = [recipientAddress, ...existing].slice(0, 50);
  await user.save();
  return res.json({ recipientAddresses: user.recipientAddresses });
});

app.patch('/api/account/settings', requireSession, requireDatabase, async (req, res) => {
  const phoneNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.trim() : null;
  if (phoneNumber === null || phoneNumber.length > 30) {
    return res.status(400).json({ message: 'Enter a valid phone number.' });
  }
  const user = await User.findOneAndUpdate(
    { googleId: req.session.sub },
    { $set: { phoneNumber } },
    { new: true },
  ).lean();
  if (!user) return res.sendStatus(404);
  return res.json({ phoneNumber: user.phoneNumber || '' });
});

app.patch('/api/notifications/:id/read', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Notification was not found.' });
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.session.sub },
    { $set: { read: true } },
    { new: true },
  ).lean();
  if (!notification) return res.sendStatus(404);
  return res.json({ notification });
});

app.post('/api/orders/:orderId/cancel', requireSession, requireDatabase, async (req, res) => {
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  const idempotencyKey = typeof req.body?.idempotencyKey === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(req.body.idempotencyKey)
    ? req.body.idempotencyKey
    : null;
  if (!reason) return res.status(400).json({ message: 'Choose a cancellation reason before continuing.' });
  if (!idempotencyKey) return res.status(400).json({ message: 'A valid cancellation request key is required.' });
  try {
    const result = await withMongoTransaction(async (session) => {
      const order = await Order.findOne({ orderId: req.params.orderId, userId: req.session.sub }).session(session);
      if (!order) throw Object.assign(new Error('Order was not found.'), { status: 404 });
      if (order.cancellationId || order.cancelledAt || order.orderStatus === 'Cancelled') {
        if (order.cancellationIdempotencyKey !== idempotencyKey) {
          throw Object.assign(new Error('This order has already been cancelled.'), { status: 409 });
        }
        return {
          order: order.toObject(),
          cancellationId: order.cancellationId,
          amountPaise: order.cancellationRefundAmountPaise || 0,
          walletBalanceAfterPaise: order.cancellationBalanceAfterPaise || 0,
          duplicate: true,
        };
      }
      const orderValue = order.toObject();
      const discountPurchases = order.orderType === 'DISCOUNT_CODE'
        ? await PurchasedDiscountCode.find({ orderId: order.orderId }).session(session).lean()
        : [];
      const hasUnusedDiscountCodePurchases = orderDiscountCodePurchasesAreUnused(orderValue, discountPurchases);
      const eligibility = cancellationEligibilityFor(orderValue, hasUnusedDiscountCodePurchases);
      if (!eligibility.eligible) throw Object.assign(new Error(eligibility.reason), { status: 409 });
      if (order.orderType === 'DISCOUNT_CODE') {
        const revoked = await PurchasedDiscountCode.updateMany(
          { orderId: order.orderId, fulfillmentStatus: 'fulfilled', redemptionCount: 0 },
          { $set: { fulfillmentStatus: 'rejected' } },
          { session },
        );
        if (revoked.modifiedCount !== discountPurchases.length) {
          throw Object.assign(new Error('This Discount Promo Code is no longer available for cancellation.'), { status: 409 });
        }
        const quantitiesByOffer = new Map();
        for (const purchase of discountPurchases) {
          const offerId = String(purchase.offerId);
          quantitiesByOffer.set(offerId, (quantitiesByOffer.get(offerId) || 0) + 1);
        }
        for (const [offerId, quantity] of quantitiesByOffer) {
          const restoredOffer = await DiscountCodeOffer.updateOne(
            { _id: offerId, purchasedCount: { $gte: quantity } },
            { $inc: { availableQuantity: quantity, purchasedCount: -quantity } },
            { session },
          );
          if (!restoredOffer.modifiedCount) {
            throw Object.assign(new Error('The Discount Promo Code inventory could not be restored.'), { status: 409 });
          }
        }
      }
      await restoreInventoryForOrder(session, order);
      const amountPaise = toPaise(order.total);
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
        throw Object.assign(new Error('The paid order amount is not valid for cancellation.'), { status: 409 });
      }
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet) throw Object.assign(new Error('The Wallet used for this order could not be found.'), { status: 409 });
      const cancellationId = `CN-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const cancelledAt = new Date();
      const balanceBeforePaise = wallet.balancePaise;
      wallet.balancePaise += amountPaise;
      await wallet.save({ session });
      const [transaction] = await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Cancellation Refund',
        amountPaise,
        balanceBeforePaise,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: `cancellation:${cancellationId}`,
        orderId: order.orderId,
        cancellationId,
        description: `Wallet refund for cancelled order ${order.orderId} · ${cancellationId}`,
        status: 'Completed',
      }], { session });
      order.orderStatus = 'Cancelled';
      order.cancelledAt = cancelledAt;
      order.cancellationId = cancellationId;
      order.cancellationIdempotencyKey = idempotencyKey;
      order.cancellationReason = reason;
      order.cancellationType = 'CUSTOMER_REQUEST';
      order.cancelledBy = req.session.sub;
      order.cancellationRefundAmountPaise = amountPaise;
      order.cancellationRefundTransactionId = transaction._id;
      order.cancellationBalanceAfterPaise = wallet.balancePaise;
      order.statusHistory.push({ status: 'Cancellation Requested', note: reason, createdAt: cancelledAt });
      order.statusHistory.push({ status: 'Cancelled', note: `Cancelled by customer. ${reason}`, createdAt: cancelledAt });
      await order.save({ session });
      await reverseRewardPointsForOrder(session, order.toObject(), { referenceId: `cancellation:${cancellationId}`, refundAmountPaise: amountPaise });
      await releaseDiscountRedemptionForOrder(session, order.orderId);
      await createCreditNoteForRefund(session, { userId: order.userId, orderId: order.orderId, refundCaseId: `CN-${cancellationId}`, amountPaise, reason });
      await Notification.create([{ userId: req.session.sub, message: `Order ${order.orderId} was cancelled. ₹${money(amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} was returned to your Wallet.` }], { session });
      return { order: order.toObject(), cancellationId, amountPaise, walletBalanceAfterPaise: wallet.balancePaise, duplicate: false };
    });
    return res.json({
      order: result.order,
      cancellation: { cancellationId: result.cancellationId, amount: money(result.amountPaise), reason: result.order.cancellationReason },
      wallet: { balance: money(result.walletBalanceAfterPaise) },
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This cancellation has already been processed.' });
    throw error;
  }
});

app.post('/api/orders', requireSession, requireDatabase, async (req, res) => {
  const { items, address, service = 'parts', projectDescription = '', razorpayId, discountCode } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50) {
    return res.status(400).json({ message: 'The order must contain at least one item.' });
  }
  if (!['parts', 'coding', 'building', 'full'].includes(service)) return res.status(400).json({ message: 'Choose a valid project service.' });
  let resolved;
  try {
    resolved = await resolveOrderItems(items, req.session.sub);
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message || 'An item in the cart is unavailable.' });
  }
  const { safeItems, customOrders } = resolved;
  const deliveryRequired = orderRequiresDelivery(safeItems);
  if (deliveryRequired && !validateAddress(address)) return res.status(400).json({ message: 'Complete the required delivery address fields.' });
  const calculated = calculateOrder(safeItems, service);
  const paymentId = typeof razorpayId === 'string' ? razorpayId.trim() : '';
  if (!paymentId) return res.status(400).json({ message: 'A verified Razorpay payment is required to place this order.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay payment verification is not configured.' });
  let paymentAmountPaise = 0;
  let paymentVerified = false;
  try {
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
    });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.currency !== 'INR' || payment.status !== 'captured' || !Number.isSafeInteger(payment.amount)) {
      return res.status(409).json({ message: 'Payment amount or capture status could not be verified; no order or reward points were created.' });
    }
    paymentAmountPaise = payment.amount;
    paymentVerified = true;
  } catch {
    return res.status(503).json({ message: 'Razorpay payment verification is temporarily unavailable.' });
  }
  let discount = null;
  try {
    if (discountCode) discount = await discountCodeContext({ session: null, userId: req.session.sub, code: discountCode, items: safeItems });
  } catch (error) {
    try { await refundRazorpayPayment(paymentId, paymentAmountPaise); } catch (refundError) {
      return res.status(409).json({ message: `${error.message} Automatic refund failed: ${refundError.message}` });
    }
    return res.status(error.status || 409).json({ message: `${error.message} The captured payment was refunded.` });
  }
  const discountAmountPaise = discount?.discountAmountPaise || 0;
  const payableTotalPaise = Math.max(0, calculated.totalPaise - discountAmountPaise);
  if (paymentAmountPaise !== payableTotalPaise) {
    try { await refundRazorpayPayment(paymentId, paymentAmountPaise); } catch (refundError) {
      return res.status(409).json({ message: `The captured amount did not match this order. Automatic refund failed: ${refundError.message}` });
    }
    return res.status(409).json({ message: 'Payment amount did not match the server-calculated order total; the captured payment was refunded.' });
  }
  const previouslyUsedPayment = await Order.findOne({ razorpayId: paymentId }).select('userId orderId').lean();
  if (previouslyUsedPayment && previouslyUsedPayment.userId !== req.session.sub) {
    return res.status(409).json({ message: 'This payment has already been linked to another order.' });
  }
  const orderId = `IL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  try {
    const result = await withMongoTransaction(async (session) => {
      const existingOrder = paymentId
        ? await Order.findOne({ userId: req.session.sub, razorpayId: paymentId }).session(session).lean()
        : null;
      if (existingOrder) return { order: existingOrder, notification: null, duplicate: true };
      await enforceOrderLimit(session);
      const inventoryDeductedAt = await applyInventoryReduction(session, safeItems);
      const [order] = await Order.create([{
        orderId,
        orderType: safeItems.every((item) => item.discountOfferId) ? 'DISCOUNT_CODE' : 'PRODUCT',
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        items: safeItems,
        address: deliveryRequired ? address : null,
        deliveryRequired,
        service,
        projectDescription: String(projectDescription).slice(0, 2000),
        subtotal: money(calculated.subtotalPaise),
        discountAmountPaise,
        discountCode: discount?.code || '',
        codingCharge: money(calculated.codingChargePaise),
        buildingCharge: money(calculated.buildingChargePaise),
        deliveryCharge: money(calculated.deliveryChargePaise),
        total: money(payableTotalPaise),
        paymentStatus: 'Paid',
        paymentMethod: 'Razorpay',
        inventoryDeductedAt,
        orderStatus: 'Processing',
        statusHistory: [{ status: 'Processing', note: 'Order created', createdAt: new Date() }],
        razorpayId: paymentId,
      }], { session });
      const discountCodes = await fulfillDiscountOfferItems(session, safeItems, { userId: req.session.sub, orderId });
      if (discount) {
        const redeemed = await redeemDiscountCode(session, { userId: req.session.sub, code: discount.code, items: safeItems, orderId });
        if (redeemed.discountAmountPaise !== discountAmountPaise) throw Object.assign(new Error('The discount changed during payment; the order was not committed.'), { status: 409 });
      }
      await awardRewardPointsForOrder(session, order);
      await createInvoiceForOrder(session, order);
      await createScratchCardForOrder(session, order);
      if (customOrders.length) {
        await CustomOrder.updateMany(
          { _id: { $in: customOrders.map((customOrder) => customOrder._id) }, userId: req.session.sub, status: 'Accepted' },
          { $set: { status: 'Ordered', orderedAt: new Date() } },
          { session },
        );
      }
      const [notification] = await Notification.create([{
        userId: req.session.sub,
        message: `Order ${orderId} was placed successfully.`,
      }], { session });
      return { order, discountCodes, notification, duplicate: false };
    });
    const savedOrder = result.order.toObject ? result.order.toObject() : result.order;
    return res.status(result.duplicate ? 200 : 201).json({
      ...result,
      order: {
        ...savedOrder,
        discountCodes: result.discountCodes || await discountCodesForOrder(savedOrder.orderId),
      },
    });
  } catch (error) {
    if (paymentVerified) {
      try {
        const refund = await refundRazorpayPayment(paymentId, paymentAmountPaise);
        const refundMessage = refund.alreadyRefunded || refund.refundId
          ? 'The payment was refunded because the order could not be completed.'
          : 'The order could not be completed and the captured payment was refunded.';
        return res.status(409).json({ message: refundMessage, refundId: refund.refundId || null });
      } catch (refundError) {
        return res.status(409).json({ message: `${error.message} No order was created. Automatic refund failed: ${refundError.message}` });
      }
    }
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

app.get('/api/custom-orders', requireSession, requireDatabase, async (req, res) => {
  const [customOrders, notifications] = await Promise.all([
    CustomOrder.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean(),
    Notification.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  return res.json({ customOrders, notifications });
});

app.post('/api/custom-orders', requireSession, requireDatabase, async (req, res) => {
  const requestedItem = typeof req.body?.requestedItem === 'string' ? req.body.requestedItem.trim() : '';
  if (!requestedItem || requestedItem.length > 120) {
    return res.status(400).json({ message: 'Enter an item name up to 120 characters long.' });
  }

  const normalizedItem = requestedItem.toLocaleLowerCase();
  const activeRequest = await CustomOrder.findOne({
    userId: req.session.sub,
    normalizedItem,
    status: { $in: ['Pending', 'Accepted'] },
  }).lean();
  if (activeRequest) return res.json({ customOrder: activeRequest, duplicate: true });

  try {
    const customOrder = await CustomOrder.create({
      userId: req.session.sub,
      userName: req.session.name || req.session.email.split('@')[0],
      userEmail: req.session.email,
      requestedItem,
      normalizedItem,
      status: 'Pending',
    });
    return res.status(201).json({ customOrder, duplicate: false });
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await CustomOrder.findOne({ userId: req.session.sub, normalizedItem, status: 'Pending' }).lean();
      if (duplicate) return res.json({ customOrder: duplicate, duplicate: true });
    }
    throw error;
  }
});

app.get('/api/admin/custom-orders', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const customOrders = await CustomOrder.find().sort({ createdAt: -1 }).lean();
  return res.json({ customOrders });
});

app.patch('/api/admin/custom-orders/:id', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: 'Custom order was not found.' });
  }

  const { status, price } = req.body || {};
  if (!['Accepted', 'Rejected'].includes(status)) {
    return res.status(400).json({ message: 'Choose Accept or Reject for this request.' });
  }
  if (status === 'Accepted' && (!Number.isFinite(Number(price)) || Number(price) < 1)) {
    return res.status(400).json({ message: 'Enter a valid price before accepting this request.' });
  }

  const updates = status === 'Accepted'
    ? { status, price: Number(price), acceptedAt: new Date() }
    : { status };
  const customOrder = await CustomOrder.findOneAndUpdate(
    { _id: req.params.id, status: 'Pending' },
    { $set: updates },
    { new: true, runValidators: true },
  ).lean();
  if (!customOrder) return res.status(409).json({ message: 'This request is no longer pending.' });

  if (status === 'Accepted') {
    await Notification.create({
      userId: customOrder.userId,
      customOrderId: customOrder._id,
      message: `${customOrder.requestedItem} was accepted and is available to order for ₹${customOrder.price}.`,
    });
  } else {
    await Notification.create({
      userId: customOrder.userId,
      customOrderId: customOrder._id,
      message: `${customOrder.requestedItem} was not accepted.`,
    });
  }
  return res.json({ customOrder });
});

app.post('/api/custom-orders/:id/ordered', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: 'Custom order was not found.' });
  }
  const customOrder = await CustomOrder.findOneAndUpdate(
    { _id: req.params.id, userId: req.session.sub, status: 'Accepted' },
    { $set: { status: 'Ordered', orderedAt: new Date() } },
    { new: true },
  ).lean();
  if (!customOrder) return res.status(409).json({ message: 'This accepted custom order is no longer available.' });
  return res.json({ customOrder });
});

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path === '/api' || req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(frontendBuildPath, 'app.html'));
});

app.listen(port, () => console.log(`Auth server listening on http://localhost:${port}`));

if (!process.env.MONGODB_URI) {
  databaseDiagnostic = { state: 'disconnected', errorType: 'configuration' };
  console.warn('MONGODB_URI is not configured; database-backed features and sign-in are unavailable.');
} else {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
      databaseDiagnostic = { state: 'connected', errorType: null };
      console.log('MongoDB connection status: connected');
      return seedInventory();
    })
    .catch((error) => {
      databaseDiagnostic = { state: 'disconnected', errorType: classifyDatabaseError(error) };
      console.error(`MongoDB connection failed. Error type: ${databaseDiagnostic.errorType}`);
      if (process.env.NODE_ENV === 'production') process.exit(1);
      console.warn('Continuing in development with database-backed features unavailable.');
    });
}