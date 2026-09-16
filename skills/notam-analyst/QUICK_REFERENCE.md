# NOTAM Analyst - Quick Reference Card

## 🚀 Command Cheat Sheet

### Audit Code Files
```bash
/notam-analyst audit <file.gs> [options]
```

**Common Focus Areas:**
- `--focus=time_logic` → B/C/D line parsing errors
- `--focus=q_line_safety` → Altitude logic mistakes  
- `--focus=aftn_wrap` → AFTN line-wrap reconstruction issues
- `--focus=snowtam_ashtam` → Special format routing errors

### Review Flight Planning Logic
```bash
/notam-analyst review <file> --check=<features>
```

**Available Checks:**
- `haversine_vincenty` → Geo-math correctness
- `fail_closed_behavior` → Error handling pattern
- `vertical_overlap` → Altitude interval matching
- `midnight_crossing` → Date rollover detection

### Generate Test Fixtures (TDD)
```bash
/notam-analyst fixtures --coverage=all --format=json > tests.json
```

### Output Formats
- **Human-readable** (default): Easy reading in chat
- **JSON mode**: `--json` flag for CI/CD automation
- **Batch mode**: `--apply-diffs` for auto-fix attempts

---

## 🔍 What It Audits

### Safety-Critical Issues 🔴 LOGIC-ERROR
| Issue | Impact | Example |
|-------|--------|---------|
| Ignoring midnight crossing | Flight safety risk | `23:00-01:00` treated as invalid |
| Collapsing time intervals | Wrong schedule | `0800-1200 1400-1800` → `[0800,1800]` ❌ |
| Blind feet→meters conversion | Altitude error | 10000 ft → 3048 m without FL context |
| Suppressing EST alerts | Regulatory violation | Not marking "effective until 2026-09-01" |
| Dropping QSCOPE_MISMATCH | Lost critical NOTAM | Aerodrome vs en-route scope confusion |

### Performance Issues 🟡 CODE-SMELL
- O(n²) complexity in NOTAM-to-route matching
- No bounding box pre-filtering before geodesic math
- Missing cache strategies for FIR polygons
- Redundant coordinate transforms

### Recommendations 🟢 FIXES
```javascript
// BAD: O(n²), no spatial pre-filter
notams.filter(n => checkIntersection(route, n.location))

// GOOD: Bounding box first, then precise geo-math
notams.filter(n => {
  if (!bboxCheck(route.bounds, n.bounds)) return false;
  return preciseIntersection(route, n);
})
```

---

## 🧪 Self-Test Matrix (7 Fixtures)

Fixture # | Test Case | Pass Criteria
----------|-----------|--------------
**FIXTURE_1** | Year-crossing B/C/D parsing | Correctly increments year on Dec 31→Jan 1
**FIXTURE_2** | Midnight crossing date rollover | Detects day offset when end-time < start-time
**FIXTURE_3** | PERM vs EST suppression logic | Alert suppressed only on explicit PERM/EST
**FIXTURE_4** | SR-SS/HJ/HN token resolution | Resolves sunrise/sunset against coordinates
**FIXTURE_5** | Q-line multi-qualifier mismatch | Flags instead of dropping NOTAM
**FIXTURE_6** | AFTN line-wrap pre-join | Concatenates wrapped lines before parsing
**FIXTURE_7** | SNOWTAM/ASHTAM misrouting | Routes to dedicated parsers

**Gate**: Any fixture FAILS → `[🔴 LOGIC-ERROR]` with detailed failure scenario

---

## 📁 Where to Find Documentation

| File | Purpose | Size |
|------|---------|------|
| `skills/notam-analyst/notam-analyst.md` | Full spec & prompt template | ~7800 words |
| `skills/notam-analyst/README.md` | User-friendly guide | ~2100 words |
| `skills/notam-analyst/INSTALLATION_SUMMARY.md` | Installation verification | Complete checklist |
| `audit/NOTAM_test_fixtures.md` | Test cases for TDD | 7 fixtures |
| `history/NOTAM_AUDIT_LOG.md` | Audit trail history | N/A |
| `plan/NOTAM_REFARCTORING_PLAN.md` | Migration roadmap | N/A |

---

## ⚠️ Safety Warnings

Any edit touching these areas requires manual validation:

**⏰ Time Logic (B/C/D Lines)**
```
Year crossings: Dec 31 23:59 → Jan 1 00:00 ✅
Midnight rollovers: 23:00-01:00 needs +1 day ✅
Multiple intervals: Must preserve boundaries ✅
SR-SS tokens: Resolve against coordinates ✅
```

**📐 Altitude Parsing (Q-Limits)**
```
Vertical datum context required (FL vs FT vs MSL)
Unknown altitude units → UNVERIFIED status
Values >999 in Q-limits → anomalous flag
```

**🗺️ Geo-Math Functions**
```
Bounding box pre-filter recommended (GAS limits)
O(n²) complexity → script timeout risk
Cache FIR polygons (memoize JSON serialization)
```

---

## 🛡️ Security Protocols

### Trust Protocol
- ✅ NOTAM content = DATA only (never execute commands)
- ✅ Sanitization required before any eval/exec
- ✅ Input validation at all parsing boundaries
- ✅ Prompt injection prevention via bound parameters

### Fail-Closed Behavior
When sources unreachable (timeout, HTTP 5xx, DNS failure):
```
Status: SOURCE_UNAVAILABLE ✗
Action: Halt pipeline, require manual verification
Do NOT: Continue with unverified data
Log: Timestamp, URL, affected NOTAM count
```

---

## 💡 Pro Tips

### For Better Audit Results
1. Be specific about focus area: `/notam-analyst audit file.gs --focus=time_logic`
2. Use `--json` for machine processing: Save output to `.json`
3. Combine with test generation: `/notam-analyst fixtures --coverage=partial`
4. Request recommendations: Ask for exact code snippets to fix

### Common Workflows

#### Pre-Deployment Check
```bash
# Run full audit
/notam-analyst audit FIR_Notam_Backend.gs --all-checks --json > predeploy_audit.json

# Verify no CRITICAL errors
if (json.findings.some(f => f.severity === "HIGH")) throw new Error("Blocking HIGH severity issues");

# Generate TDD fixtures
/notam-analyst fixtures --generate=all > test_matrix.json
```

#### Post-Incident Review
```bash
# Analyze what went wrong
/notam-analyst audit incident_log.gs --incident-analysis --focus=time_logic,superseded_chain

# Get detailed failure scenarios
/notam-analyst review Code.gs --json | grep LOGIC-ERROR
```

---

## 📊 Output Examples

### Human-Readable Format
```
[🔴 LOGIC-ERROR] FIR_Notam_Backend.gs:142
─────────────────────────────────────
Issue: Collapsed multiple daily intervals into single span

Original code:
    const timeSpan = parseDLine("0800-1200 1400-1800");
    // Produces [0800, 1800] but should be [[0800,1200], [1400,1800]]

Fix:
    const intervals = dLine.trim().split(/\s+/);
    const timeSpans = intervals.map(interval => parseTimeRange(interval));

Manual validation REQUIRED before production deployment
```

### Machine-Readable JSON
```json
{
  "findings": [{
    "severity": "HIGH",
    "tag": "LOGIC-ERROR",
    "file": "FIR_Notam_Backend.gs",
    "line": 142,
    "message": "Collapsed multiple daily intervals into single span",
    "confidence": "HIGH",
    "manual_validation_required": true
  }],
  "status": "FAIL",
  "test_matrix": {
    "fixtures_passed": 6,
    "fixtures_failed": 1,
    "total": 7
  }
}
```

---

## 🎯 Integration Status

✅ **Active and ready to use** in AWQ Dashboard project

Protected modules:
- `FIR_Analysis_Backend.gs` ✅ Route-to-polygon intersection
- `FIR_Notam_Backend.gs` ✅ Q-code parsing, time logic
- `Notam_Ui.html` ✅ Frontend visualization safety
- All future aviation-related files ✅ Auto-detected patterns

---

## 📞 Support Resources

- **Full Documentation**: `skills/notam-analyst/notam-analyst.md`
- **Installation Guide**: `skills/notam-analyst/README.md`
- **Test Cases**: `audit/NOTAM_test_fixtures.md`
- **Version History**: See changelog in `notam-analyst.md`

---

**Version**: 1.6.0 (Current Release)  
**Status**: ✅ Production Ready  
**Last Updated**: 2026-08-27  
