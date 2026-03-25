#!/usr/bin/env node

/**
 * Setup Verification Script
 * Checks if all required environment variables and dependencies are configured
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const REQUIRED_ENV_VARS = [
  'JWT_SECRET',
];

const OPTIONAL_ENV_VARS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MONGODB_URI',
];

function checkEnvFile() {
  const envPath = path.join(__dirname, '..', '.env.local');
  
  console.log('🔍 Checking environment configuration...\n');
  
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env.local file not found!');
    console.log('📝 Please copy .env.example to .env.local:');
    console.log('   cp .env.example .env.local\n');
    return false;
  }
  
  console.log('✅ .env.local file exists');
  
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const envLines = envContent.split('\n');
  const envVars = {};
  
  envLines.forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      envVars[match[1].trim()] = match[2].trim();
    }
  });
  
  console.log('\n📋 Required Variables:');
  let allRequired = true;
  
  REQUIRED_ENV_VARS.forEach(varName => {
    const value = envVars[varName];
    if (!value || value.includes('your-') || value.includes('change-this')) {
      console.log(`❌ ${varName}: Not configured or using default value`);
      allRequired = false;
    } else {
      console.log(`✅ ${varName}: Configured`);
    }
  });
  
  console.log('\n📋 Optional Variables (for email):');
  OPTIONAL_ENV_VARS.forEach(varName => {
    const value = envVars[varName];
    if (!value || value.includes('your-')) {
      console.log(`⚠️  ${varName}: Not configured (emails will not be sent)`);
    } else {
      console.log(`✅ ${varName}: Configured`);
    }
  });
  
  return allRequired;
}

function checkDependencies() {
  console.log('\n🔍 Checking dependencies...\n');
  const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
  
  if (!fs.existsSync(nodeModulesPath)) {
    console.error('❌ node_modules not found!');
    console.log('📝 Please install dependencies:');
    console.log('   npm install\n');
    return false;
  }
  
  console.log('✅ Dependencies installed');
  return true;
}

function checkDatabase() {
  console.log('\n🔍 Database Configuration:');
  console.log('ℹ️  Default: SQLite (zero-dependency, works out of the box)');
  console.log('   To use MongoDB instead, set DB_PROVIDER=mongodb and MONGODB_URI in .env.local\n');
}

function printNextSteps(envOk, depsOk) {
  console.log('\n' + '='.repeat(60));
  console.log('📝 NEXT STEPS:');
  console.log('='.repeat(60) + '\n');
  
  if (!depsOk) {
    console.log('1. Install dependencies:');
    console.log('   npm install\n');
  }
  
  if (!envOk) {
    console.log('2. Configure environment:');
    console.log('   - Copy .env.example to .env.local');
    console.log('   - Set JWT_SECRET to a strong random key (min 32 chars)');
    console.log('   - (Optional) Set DB_PROVIDER=mongodb and MONGODB_URI for MongoDB');
    console.log('   - (Optional) Configure SMTP settings for emails\n');
  }
  
  if (envOk && depsOk) {
    console.log('✅ Everything looks good!\n');
    console.log('🚀 Start the development server:');
    console.log('   npm run dev\n');
    console.log('📖 Then visit: http://localhost:3000\n');
    console.log('💡 Check GETTING_STARTED.md for more information');
  } else {
    console.log('⚠️  Please complete the steps above, then run this script again.\n');
  }
}

function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Cognipeer Console - Setup Verification');
  console.log('='.repeat(60) + '\n');
  
  const depsOk = checkDependencies();
  const envOk = checkEnvFile();
  checkDatabase();
  
  printNextSteps(envOk, depsOk);
}

main();
