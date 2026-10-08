# Deriving the development control matrix from the local plan draft

Source: `docs/local-plan-matrix-template.csv` (22 zones × 32 use groups = 704 decisions), read against what the
codebase already holds. Reproduce with `node scripts/derive-matrix-reference.js`; the outputs are in `docs/derived/`
(`zones.csv`, `land_use_groups.csv`, `development_activities.csv`, `matrix_flags.csv`).

## 1. What the draft is

| | Count | Note |
|---|---|---|
| Zones | 22 | 11 urban (the Vungu peri-urban plan's zones) + 11 rural (the district zones) |
| Use groups | 32 | A, A1–A3, B, B1–B2, C, D, D1, E, E1–E2, F … Z, UF. Identical to the 32 groups already in `land_use_groups` |
| Decisions | 704 | P permitted 352 · SC special consent 169 · X prohibited 168 · blank 15 |
| Conditions / notes / authority | 0 | not one decision carries a condition |

So the **structure** is sound and matches the schema we already have (zone types, use groups, a decision per pair, three
outcomes). The **content** is not yet a set of planning decisions. The audit (`matrix_flags.csv`) found:

1. **The rural block is the urban block relabelled.** All 11 rural columns equal an urban column cell for cell (within one
   cell): Communal Farming and High Intensive Commercial Farming = Densification Zone; Estates = Economic Corridor;
   Irrigation Scheme = High Density Residential; Smallholder Estates = Institutional; Forestry/Conservation = Light
   Industry; Game Park = Low Density Residential; Game Corridor = Medium Density Residential; Urban Expansion = Mixed
   Density; Industrial = Railways; Commercial = Residential Agricultural Plots. The 337 decisions loaded as the rural
   template's "sample" are these same columns (343 of its 352 cells equal the draft), so **the rural template in the
   database holds urban patterns under rural names.** A game park that follows the low-density residential column is not
   a judgement about game parks.
2. **Three residential zones do not allow dwellings.** High Density, Medium Density and Low Density Residential prohibit
   or only conditionally allow every dwelling group (A, A1–A3). Either the columns are shifted against their headings or
   the entries are wrong. Mixed Density, Densification and Residential Agricultural Plots do allow them.
3. **Default fills.** Cemetery, Densification Zone, Communal Farming and High Intensive Farming permit 29–30 of 32 uses,
   including industrial ones. A cemetery that permits wholesale warehouses is a column that was never decided.
4. **15 blanks** (Parking garage in 12 zones, Farm stores in three), and **no conditions** on any special
   consent, which the assessment screen needs in order to tell an officer what to look at.
5. **Gaps in the lettering.** N, O, W, Y are absent and L1 appears without L. If these follow the council's schedule of
   use classes, groups are missing. The schedule itself is not in the repository, so this is a question for the planners,
   not something to infer.

None of this makes the draft unusable. It is a good **scaffold**: the zones, the use groups and the format are right. What
it needs is a decision per column from someone who knows the zone's intent.

## 2. Zones

`zones.csv` gives each zone a profile (urban/rural), the nearest zone in our existing starter palettes, and that zone's
category and HILUCS class, all marked proposed. Points to settle:
- **Densification Zone [LDR]** reads as a policy overlay on low-density land, not a use zone. Model it as an overlay or a
  flag on a parcel, so a parcel can be "LDR and in the densification area".
- **Cemetery** is a special use with no palette equivalent; it needs its own zone type (it maps to open space only for
  want of a better home).
- **Mixed Density Residential** and **Forestry / Conservation** each name two things. Decide whether each is one zone or a
  range.
- **Estates Zone (Large Farms)** differs from High Intensive Commercial Farming only by scale. Confirm they are separate.

## 3. Land uses

`land_use_groups.csv` carries the 32 groups with what we already hold: category (residential, commercial, institutional,
industrial, agricultural, recreation) and HILUCS class. What it adds is the **hierarchy the codes imply**: A1–A3 sit under
A, B1–B2 under B, D1 under D, E1–E2 under E, J1 under J. We do not store it yet; the table has no parent. Two cells break
it (a sub-class more permissive than its class by more than one step), which `matrix_flags.csv` lists for review.
`use_scale` is empty for every group.

## 4. Development activities

The permit already records one of eight kinds of development (`permit_application.development_type`, a CHECK list). The
matrix, however, only answers the question "is this **use** allowed in this zone". Different activities ask different
questions, which is what `development_activities.csv` records:

| Activity | Tests | Matrix looked up? | Standards that apply |
|---|---|---|---|
| New building | the use being built | yes | coverage, height, setbacks, parking |
| Extension | the standards (use unchanged) | no | coverage, height, setbacks |
| Alteration | the standards | only if the use changes | height, setbacks |
| Change of use | existing use → proposed use | yes | parking |
| Subdivision | the resulting parcels | yes (intended use) | minimum stand area, frontage |
| Consolidation | the combined parcel | no | maximum stand area |
| Rezoning | the zone itself | no (amends the plan) | — |
| Other | manual | no | — |

This table is a proposal drawn from how the codes are used. It states no statutory reference; those are to be added by the
planners, with the evidence status, in the same way `decision_pathway` records them.

## 5. What the database needed, and what was built

Already there and used as is: `plan_zone_type` (category, HILUCS class), `land_use_groups`, `zone_land_use_controls`
(outcome, conditions, pathway), `decision_pathway`, the two HILUCS crosswalks, `standard_kind` and
`plan_zone_standard` (migration 143), plan sign-off.

Gaps this work exposed, now migrations (applied to the development database, and proven from scratch by
`scripts/verify-fresh-database.js`):

| Migration | What it adds |
|---|---|
| 156 | `land_use_groups.parent_group_code` (generated from the code: A1 → A) and the view `land_use_group_tree`. Generated, so copying a plan carries it. The lettered rule is the council schedule's; the starter palettes number differently and simply show no parents |
| 157 | `development_activity` (the eight kinds, what each tests, evidence status); `permit_application.development_type` becomes a foreign key to it, replacing the CHECK list. Existing permits keep their values |
| 158 | `activity_standard_kind`: which kinds of standard (from the existing `standard_kind`) each activity must meet. Proposed, no values |
| 159 | `existing_use.land_use_group_code` and `land_use_group_for(plan, code)`, so a change of use can say "from what" |
| 160 | the views `plan_matrix_audit` and `plan_matrix_audit_summary`, and `GET /api/workbench/plans/:id/audit` |

The audit is **advisory**: it blocks nothing. It reports, per plan: a residential zone that permits no dwelling outright
(error); two zones that decide every use the same way, a zone that permits nearly everything, a zone with gaps
(warnings); a sub-class permitted where its class is prohibited, a special consent with no condition, a sub-class whose
class is missing (review). Run against the database as it stands, the rural template shows 14 warnings and 13 reviews:
its columns are the urban ones under rural names, as section 1 found.

Not done, and why: the route that creates a permit still checks `development_type` against a list in
`development-management.js`; it should read `development_activity` instead, a small change left until the activity
kinds are agreed. Nothing yet *uses* `activity_standard_kind` or `land_use_group_for`: they are the data the assessment
needs next.

## 6. What only the planners can supply

- The intent of each zone and a considered column for each: start with the eleven rural zones, which are placeholders.
- Conditions for every special consent, and the pathway (notice, objection period, deciding body) each uses.
- Standards per zone, per activity (not one number is in the data).
- Whether the missing use classes (N, O, W, Y, L) exist in the council's schedule.

## 7. Vungu draft v0: working ahead of the council's review

So the application can be built and tested before the council reviews the matrix, Vungu's plan holds a **provisional**
first-cut matrix (`node scripts/seed-vungu-draft-matrix.js --apply`; the same decisions are in
`docs/vungu-draft-v0-matrix.csv` for review as a spreadsheet). It covers the 11 urban-profile zones: 64 permitted,
108 special consent, 180 prohibited. It is a proposal by the development team drawn from each zone's intent. It is not
council policy and nobody has reviewed it.

What keeps it from being mistaken for policy (migration 161):
- **The plan is provisional until it is approved or gazetted.** Vungu's plan is still recorded with status *unknown*, so
  every rule snapshot carries `provisional: true`, and the officer's zoning card says "Draft rules, not council
  policy" and writes that into the note kept on the case.
- **Each zone column has a review status** (unreviewed, in review, reviewed, with who and when). Editing a decision in a
  reviewed column puts it back in review. Marking a column reviewed does not make the plan final.
- **The public sees none of it.** The matrix read routes now follow plan visibility: only a template or a gazetted plan is
  shown to the public, and another authority's staff see nothing.
- **No conditions and no standards are entered.** Those are the council's (decisions D6 to D8), and the audit lists them as
  reviews. It reports no errors or warnings for the draft.

When the council's decisions arrive, load them with the same loader as a marked-up copy of the sheet; the diff shows
every cell that changed, and the review status records who confirmed what.
