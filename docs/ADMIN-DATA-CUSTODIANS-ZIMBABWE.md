# Who owns and maintains administrative boundary data in Zimbabwe (2026-10-08)

Desk research, to decide where the "gazetted boundary" should come from. **Status: findings from public
sources only.** The Acts themselves could not be read here (the legal-text sites refused the request),
so the statutory points below come from secondary reports and must be checked against the Act text.

## Who does what

| Concern | Custodian | Evidence |
|---|---|---|
| **Wards and constituencies** (the electoral/administrative building blocks) | **Zimbabwe Electoral Commission (ZEC)** delimits them. The last exercise was 2022, finalised February 2023: **1,970 wards and 210 constituencies**. | [ZEC 2022 preliminary report](https://www.veritaszim.net/node/6098); [ZESN analysis](https://www.zesn.org.zw/wp-content/uploads/2023/06/ZESN-Delimitation-Analysis-Report.pdf); [List of wards of Zimbabwe](https://en.wikipedia.org/wiki/List_of_wards_of_Zimbabwe) |
| **A council's area** (the local authority's jurisdiction) | Fixed by **Presidential proclamation** under the Urban Councils Act and the Rural District Councils Act; the President divides the area into wards after consulting ZEC. The Act is administered by the **Ministry of Local Government and Public Works**. Extension requests go to the Minister and ZEC. | Secondary reports: [Kubatana on the proclamation powers](https://www.kubatana.net/2018/03/19/council-elections-presidents-proclamation-new-beitbridge-municipality-usurps-zecs-functions-election-watch-3-2018/); [Rural District Councils Act (ZimLII)](https://zimlii.org/akn/zw/act/1988/8/eng@1988-08-19); [Urban Councils Act (ZimLII)](https://zimlii.org/akn/zw/act/1995/24/eng@2018-01-01). Not read directly. |
| **Survey, cadastre and source maps** | **Department of the Surveyor-General.** Earlier ward datasets were digitised from its 1:50,000 and 1:250,000 maps. A national **e-Cadastre** (360,000+ parcels) is being built under the Ministry of Lands; there are no complete boundary surveys, so no seamless cadastre yet. | [Herald on the e-Cadastre](https://www.heraldonline.co.zw/govt-puts-360-000-land-parcels-on-digital-map/); [FIG paper on Zimbabwe data handling](https://www.fig.net/resources/Proceedings/fig_proceedings/fig2012/papers/ts06e/TS06E_kurwakumire_chaminama_5502.pdf) |
| **Statistical boundaries** (provinces, districts, wards, p-codes) | **ZIMSTAT**, redistributed by OCHA through HDX as the **COD-AB** (levels 0 to 3: 10 provinces, 91 districts, **1,961 wards**). It records a review in January 2025 with no update needed. | [COD-AB on the humanitarian data catalogue](https://data.amerigeoss.org/dataset/zimbabwe-administrative-levels-0-3-boundaries) |

## What this means for us

- **Our `wards` table is the old delimitation.** It has 1,961 rows (the COD-AB, p-codes such as
  `ZW170418`); ZEC's 2022 delimitation has **1,970**. The authority-to-ward relation should be
  built on ZEC's wards, not on the COD-AB, and the two will not match one for one.
- **No public API or digital data feed from ZEC, the Ministry or the Surveyor-General was found.**
  ZEC published its report as PDFs of written boundary descriptions and provincial maps, and
  Parliament's committee criticised the coordinates as complicated and wards as unlabelled. I could not
  confirm whether ZEC will release GIS files (shapefile or GeoPackage). That has to be asked of ZEC.
- The one machine-readable national source that exists is the **COD-AB on HDX** (downloads; HDX also has
  a standard API, which I could not test from here).

## Recommended route

1. **Ask ZEC** for the delimitation as GIS data (wards, constituencies, and the ward-to-local-authority
   list), with the delimitation date. Ask the Ministry of Local Government for the proclamations that
   fix each council's area, and the instrument reference for each.
2. **Make the Surveyor-General platform the custodian we read from.** Add an administrative-boundaries
   module beside `control`: wards, authorities, the authority-ward relation, each version carrying its
   source (ZEC delimitation 2022), its gazette or proclamation reference and its effective date. VunGIS
   then reads it through the client package it already has, and keeps a versioned read-only copy. This
   gives one API where none exists, with provenance.
3. **Until then,** keep the interim boundary, label it unverified, and load the COD-AB as the stand-in
   ward set, marked as the pre-2023 delimitation.
4. **Do not draw jurisdictions.** Derive each authority's jurisdiction as the union of its wards, so a
   new delimitation changes one relation.

## Open questions

- Will ZEC release the delimitation as GIS files, and on what terms?
- Which instrument fixes each Rural District Council's area, and does it list wards?
- Who in government owns the authority list and the council-to-ward mapping: ZEC, the Ministry, or both?
- Does the Surveyor-General want to host this dataset, given it is the legal custodian of boundary surveys?
