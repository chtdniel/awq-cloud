/**
 * Unit Tests for Timezone Configuration Module (Fix #3)
 * Execute this function in Apps Script editor to verify timezone handling works correctly
 */

function smokeTestTimezoneConfig() {
  console.log('=== Smoke Test: Timezone Configuration ===\n');
  
  try {
    // Test 1: Get current script timezone
    const currentTimezone = getCurrentScriptTimezone();
    console.log(`Current Script Timezone: ${currentTimezone}`);
    
    if (!isValidTimezone(currentTimezone)) {
      console.log('⚠️  WARNING: Current timezone is not valid!');
      return { status: 'FAIL', error: 'Invalid default timezone' };
    }
    console.log('✅ PASS: Valid default timezone\n');
    
    // Test 2: Validate known timezones
    const validTimezones = [
      'UTC',
      'Asia/Jakarta',
      'Asia/Makassar',
      'America/New_York',
      'Europe/London'
    ];
    
    let allValid = true;
    for (const tz of validTimezones) {
      if (isValidTimezone(tz)) {
        console.log(`✅ PASS: ${tz} is valid`);
      } else {
        console.log(`❌ FAIL: ${tz} should be valid but detected as invalid`);
        allValid = false;
      }
    }
    
    // Test 3: Test invalid timezone detection
    try {
      setTimezone('INVALID_TIMEZONE_XYZ');
      console.log('❌ FAIL: Invalid timezone should have thrown an error');
      allValid = false;
    } catch (e) {
      console.log(`✅ PASS: Invalid timezone rejected: ${e.message}\n`);
    }
    
    // Test 4: Format timestamp correctly
    const now = new Date();
    const utcTimestamp = getUTCTimestamp();
    console.log(`Current UTC Timestamp: ${utcTimestamp}`);
    
    // Verify format: should match YYYY-MM-DD HH:MM:SS pattern
    const tsPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (tsPattern.test(utcTimestamp)) {
      console.log('✅ PASS: UTC timestamp format correct\n');
    } else {
      console.log('❌ FAIL: UTC timestamp format incorrect');
      allValid = false;
    }
    
    // Summary
    if (allValid) {
      console.log('✅ All timezone smoke tests PASSED!');
      return { status: 'PASS' };
    } else {
      console.log('⚠️ Some timezone tests FAILED - review implementation');
      return { status: 'FAIL' };
    }
    
  } catch (e) {
    console.error('[TIMEZONE TEST] Error:', e.message);
    return { status: 'ERROR', error: e.message };
  }
}


function testDateNormalization() {
  console.log('\n=== Test: Date Value Normalization ===\n');
  
  const testCases = [
    { input: '20260821', expectedFormat: 'yyyy-MM-dd', desc: 'YYYYMMDD string' },
    { input: '210826', expectedFormat: 'yyyy-MM-dd', desc: 'DDMMYY string (21st Aug 2026)' },
    { input: null, expectedFallback: true, desc: 'Null value' },
    { input: '', expectedFallback: true, desc: 'Empty string' }
  ];
  
  for (const test of testCases) {
    const result = normalizeDateValue(test.input);
    console.log(`Input: "${test.input}" -> Output: "${result}" (${test.desc})`);
    
    if (test.expectedFallback) {
      if (typeof result === 'string' && result.length > 0) {
        console.log('✅ PASS: Fallback behavior correct');
      } else {
        console.log('❌ FAIL: Fallback not working');
      }
    }
  }
  
  console.log('\n✅ Date normalization tests complete\n');
}


function testFlightWindowCalculation() {
  console.log('\n=== Test: Flight Window Calculation ===\n');
  
  const flightData = {
    DOF: '2026-08-21',
    STD: '10:00',
    STA: '14:00',
    DEP: 'WADD',
    ARR: 'WIII'
  };
  
  const window = calculateFlightWindow(flightData);
  
  console.log(`Flight: ${flightData.DEP} -> ${flightData.ARR}`);
  console.log(`DOF: ${flightData.DOF}`);
  console.log(`STD: ${flightData.STD}, STA: ${flightData.STA}`);
  console.log(`Calculated Window:`);
  console.log(`  Start: ${window.start || 'N/A'}`);
  console.log(`  End: ${window.end || 'N/A'}`);
  console.log(`  Valid: ${window.valid ? 'Yes' : 'No'}`);
  
  // Expected values
  const expectedStart = '2026-08-21 10:00';
  const expectedEnd = '2026-08-21 14:00';
  
  if (window.valid && window.start === expectedStart && window.end === expectedEnd) {
    console.log('✅ PASS: Flight window calculation correct\n');
    return { status: 'PASS', window };
  } else {
    console.log('❌ FAIL: Flight window calculation incorrect\n');
    return { status: 'FAIL', window };
  }
}


// Run all timezone tests
function runAllTimezoneTests() {
  console.log('=== FULL TIMEZONE CONFIGURATION TEST SUITE ===\n');
  console.log('Session: 2026-08-21');
  console.log('Purpose: Verify TimezoneConfig.gs fixes timezone inconsistency issue\n');
  
  const results = [];
  
  // Test 1: Smoke tests
  results.push({ test: 'Smoke Tests', ...smokeTestTimezoneConfig() });
  
  // Test 2: Date normalization
  results.push({ test: 'Date Normalization', ...testDateNormalization() });
  
  // Test 3: Flight window calculation
  results.push({ test: 'Flight Window Calculation', ...testFlightWindowCalculation() });
  
  // Summary
  console.log('=== SUMMARY ===');
  let passed = 0;
  let failed = 0;
  
  for (const r of results) {
    if (r.status === 'PASS') {
      console.log(`✅ ${r.test}: PASSED`);
      passed++;
    } else {
      console.log(`❌ ${r.test}: FAILED - ${r.error || 'Logic error'}`);
      failed++;
    }
  }
  
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length} tests`);
  
  if (failed === 0) {
    console.log('\n🎉 All timezone configuration tests PASSED!');
    console.log('Timezone standardization is ready for production.');
    return { overallStatus: 'PASS', details: results };
  } else {
    console.log('\n⚠️  Some tests FAILED - review TimezoneConfig.gs implementation');
    return { overallStatus: 'FAIL', details: results };
  }
}

