'use strict';

const ROLE_ALIASES = new Map([
  ['DEFAULT', 'DEFAULT'], ['DEFAULTS', 'DEFAULT'],
  ['EARLY', 'EARLY'], ['EARLY BUYER', 'EARLY'], ['EARLY_BUYER', 'EARLY'],
  ['WHALE', 'WHALE'], ['TOP HOLDER', 'WHALE'], ['TOP_HOLDER', 'WHALE'],
  ['DEV', 'DEV'], ['DEVELOPER', 'DEV'], ['CREATOR', 'DEV'],
  ['RUG/KOL', 'RUG/KOL'], ['RUG', 'RUG/KOL'], ['KOL', 'RUG/KOL'], ['RUG_KOL', 'RUG/KOL']
]);

function normalizeRoleLabel(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().replace(/\s+/g, ' ').toUpperCase();
  return ROLE_ALIASES.get(key) || null;
}

function roleFromName(name) {
  const n = String(name || '').trim().toUpperCase();
  if (/^E(?:ARLY)?[-_ ]/.test(n)) return ['EARLY'];
  if (/^W(?:HALE)?[-_ ]/.test(n)) return ['WHALE'];
  if (/^D(?:EV)?[-_ ]/.test(n)) return ['DEV'];
  if (/^RUG[-_ ]/.test(n) || /^KOL[-_ ]/.test(n)) return ['RUG/KOL'];
  if (n === 'DEFAULT' || n === 'MAIN') return ['DEFAULT'];
  return [];
}

function normalizeWalletRoles(wallet) {
  const groups = Array.isArray(wallet?.groups) ? wallet.groups : [];
  const structured = [...new Set(groups.map(normalizeRoleLabel).filter(Boolean))];
  const legacy = roleFromName(wallet?.name);
  const unknownGroups = groups.filter(g => !normalizeRoleLabel(g));
  const hasStructuredRole = structured.length > 0;
  const roles = hasStructuredRole ? structured : (legacy.length ? legacy : ['DEFAULT']);
  const conflicts = hasStructuredRole && legacy.length
    ? legacy.filter(role => !structured.includes(role)).map(role => ({ source: 'name', role, conflicts_with: structured }))
    : [];
  return {
    roles,
    role_source: hasStructuredRole ? 'groups' : (legacy.length ? 'name_fallback' : 'default_fallback'),
    role_conflicts: conflicts,
    unrecognized_groups: unknownGroups
  };
}

function calculateRoleWeight(roles, scoring = {}) {
  const weights = scoring.wallet_weights || {};
  const map = { DEFAULT: weights.default ?? 1, EARLY: weights.early ?? 2, WHALE: weights.whale ?? 3, DEV: weights.dev ?? -1, 'RUG/KOL': weights.rug_kol ?? -2 };
  return roles.reduce((sum, role) => sum + Number(map[role] ?? 0), 0);
}

function extractModifiers(wallet, scoring = {}) {
  const text = `${wallet?.name || ''}${wallet?.emoji || ''}`;
  const symbols = [];
  if (text.includes('⭐')) symbols.push('⭐');
  if (text.includes('💚')) symbols.push('💚');
  if (text.includes('🚩')) symbols.push('🚩');
  if (text.includes('🚫')) symbols.push('🚫');
  const modifiers = scoring.modifiers || {};
  const valueFor = (symbol) => {
    switch (symbol) {
      case '⭐': return modifiers.star ?? 5;
      case '💚': return modifiers.priority ?? 2;
      case '🚩': return modifiers.flag ?? -5;
      case '🚫': return modifiers.blocked ?? -10;
      default: return 0;
    }
  };
  const weight = symbols.reduce((sum, symbol) => sum + Number(valueFor(symbol)), 0);
  return { symbols, weight };
}

module.exports = { normalizeRoleLabel, roleFromName, normalizeWalletRoles, calculateRoleWeight, extractModifiers };
