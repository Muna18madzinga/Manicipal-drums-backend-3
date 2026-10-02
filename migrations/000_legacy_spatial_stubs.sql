-- 000: Empty-but-shaped placeholders for legacy spatial tables.
-- These objects only ever get populated from external sources (ogr2ogr
-- imports via setup:spatial, the supervisor dump, legacy GeoPackage imports).
-- Fresh deployments need only the *shape* so indexes, FKs and views parse;
-- running the real imports later replaces these shells with live data.

--
-- PostgreSQL database dump
--

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6
--
-- Name: buildings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.buildings (
    fid integer CONSTRAINT buildings__vungu_clip_fid_not_null NOT NULL,
    geom public.geometry(MultiPolygon,4326),
    osm_id character varying(12),
    code integer,
    fclass character varying(28),
    name character varying(100),
    type character varying(20)
);
--
-- Name: development_matrix; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.development_matrix (
    id integer NOT NULL,
    zone_code text NOT NULL,
    use_code text NOT NULL,
    permission_code text NOT NULL,
    permission_description text,
    conditions text,
    restrictions text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);
--
-- Name: TABLE development_matrix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.development_matrix IS 'Matrix defining permitted uses for each zone type';
--
-- Name: development_matrix_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.development_matrix_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--
-- Name: development_matrix_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.development_matrix_id_seq OWNED BY public.development_matrix.id;
--
-- Name: districts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.districts (
    fid integer NOT NULL,
    geom public.geometry(MultiPolygon,4326),
    pcode character varying,
    name_en character varying,
    parent_pcode character varying,
    level bigint
);
--
-- Name: TABLE districts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.districts IS 'Zimbabwe district boundaries (ADM2)';
--
-- Name: districts_fid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.districts_fid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--
-- Name: districts_fid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.districts_fid_seq OWNED BY public.districts.fid;
--
-- Name: gweru_health_centres; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gweru_health_centres (
    id integer NOT NULL,
    geom public.geometry(MultiPoint,4326),
    district character varying(50),
    longitude double precision,
    latitude double precision,
    elevation double precision,
    updated integer,
    nameoffaci character varying(50),
    ownership character varying(50),
    yearbuilt integer,
    typeoffaci character varying(50),
    numofdocto integer,
    numofnurse integer,
    numofnur_1 integer,
    numofpcn integer,
    numofehts integer,
    numofpharm integer,
    numoflabte integer,
    numofbeds integer,
    numofmater integer,
    numofgener integer,
    cathmentpo integer,
    distneares double precision,
    hascommuni integer,
    hascommu_1 integer,
    haswaterpi integer,
    haswaterun integer,
    haselectri integer,
    haselect_1 integer,
    distnear_1 double precision,
    hassanitat integer,
    hassanit_1 integer,
    hassanit_2 integer,
    hassecurit integer,
    hassecur_1 integer,
    hasroadtar integer,
    hasroadgra integer,
    hasinciner integer,
    hasautoway integer,
    hasdental integer,
    comments character varying(254),
    type_edite character varying(40)
);
--
-- Name: gweru_peri_urban_zone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gweru_peri_urban_zone (
    id integer NOT NULL,
    geom public.geometry(MultiPolygon,4326),
    fid double precision,
    area_ha double precision,
    zone character varying(50),
    area double precision,
    lb character varying(50),
    shape_leng double precision,
    shape_area double precision,
    zone_code character varying(10),
    zone_type character varying(50),
    map_color character varying(7),
    display_order integer,
    is_active boolean
);
--
-- Name: land_use_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.land_use_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_code character varying(32) NOT NULL,
    description text,
    group_category character varying(32),
    development_category character varying(32),
    use_scale character varying(32),
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
--
-- Name: proposed_peri_urban_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proposed_peri_urban_zones (
    id integer NOT NULL,
    zone text,
    zone_code character varying,
    zone_type text,
    scale_category text,
    authority text,
    zone_description text,
    is_active boolean,
    map_color text,
    display_order integer,
    geom public.geometry(MultiPolygon,4326),
    ward character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
--
-- Name: wards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wards (
    fid integer NOT NULL,
    geom public.geometry(MultiPolygon,4326),
    pcode character varying,
    name_en character varying,
    parent_pcode character varying,
    level bigint
);
--
-- Name: TABLE wards; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.wards IS 'Zimbabwe ward boundaries (ADM3)';
--
-- Name: wards_fid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wards_fid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--
-- Name: wards_fid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wards_fid_seq OWNED BY public.wards.fid;
--
-- Name: zone_land_use_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zone_land_use_controls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    zone_id uuid NOT NULL,
    land_use_group_id uuid NOT NULL,
    control_type character varying(20) NOT NULL,
    authority character varying(100) DEFAULT 'Vungu RDC'::character varying,
    notes text,
    conditions text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT zone_land_use_controls_control_type_check CHECK (((control_type)::text = ANY (ARRAY[('permitted'::character varying)::text, ('prohibited'::character varying)::text, ('special_consent'::character varying)::text])))
);
--
-- Name: development_matrix id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.development_matrix ALTER COLUMN id SET DEFAULT nextval('public.development_matrix_id_seq'::regclass);
--
-- Name: districts fid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.districts ALTER COLUMN fid SET DEFAULT nextval('public.districts_fid_seq'::regclass);
--
-- Name: wards fid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wards ALTER COLUMN fid SET DEFAULT nextval('public.wards_fid_seq'::regclass);
--
-- Name: buildings buildings_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buildings
    ADD CONSTRAINT buildings_pk PRIMARY KEY (fid);
--
-- Name: development_matrix development_matrix_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.development_matrix
    ADD CONSTRAINT development_matrix_pkey PRIMARY KEY (id);
--
-- Name: districts districts_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.districts
    ADD CONSTRAINT districts_pk PRIMARY KEY (fid);
--
-- Name: gweru_health_centres gweru_health_centres_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gweru_health_centres
    ADD CONSTRAINT gweru_health_centres_pkey PRIMARY KEY (id);
--
-- Name: gweru_peri_urban_zone gweru_peri_urban_zone_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gweru_peri_urban_zone
    ADD CONSTRAINT gweru_peri_urban_zone_pkey PRIMARY KEY (id);
--
-- Name: land_use_groups land_use_groups_group_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.land_use_groups
    ADD CONSTRAINT land_use_groups_group_code_key UNIQUE (group_code);
--
-- Name: land_use_groups land_use_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.land_use_groups
    ADD CONSTRAINT land_use_groups_pkey PRIMARY KEY (id);
--
-- Name: proposed_peri_urban_zones proposed_peri_urban_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposed_peri_urban_zones
    ADD CONSTRAINT proposed_peri_urban_zones_pkey PRIMARY KEY (id);
--
-- Name: zone_land_use_controls uq_zlc_zone_group; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zone_land_use_controls
    ADD CONSTRAINT uq_zlc_zone_group UNIQUE (zone_id, land_use_group_id);
--
-- Name: wards wards_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wards
    ADD CONSTRAINT wards_pk PRIMARY KEY (fid);
--
-- Name: zone_land_use_controls zone_land_use_controls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zone_land_use_controls
    ADD CONSTRAINT zone_land_use_controls_pkey PRIMARY KEY (id);
--
-- Name: buildings_geom_geom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX buildings_geom_geom_idx ON public.buildings USING gist (geom);
--
-- Name: districts_geom_geom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX districts_geom_geom_idx ON public.districts USING gist (geom);
--
-- Name: idx_development_matrix_zone_use; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_development_matrix_zone_use ON public.development_matrix USING btree (zone_code, use_code);
--
-- Name: idx_zlc_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zlc_group_id ON public.zone_land_use_controls USING btree (land_use_group_id);
--
-- Name: idx_zlc_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zlc_type ON public.zone_land_use_controls USING btree (control_type);
--
-- Name: idx_zlc_zone_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zlc_zone_id ON public.zone_land_use_controls USING btree (zone_id);
--
-- Name: proposed_peri_urban_zones_geom_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proposed_peri_urban_zones_geom_gix ON public.proposed_peri_urban_zones USING gist (geom);
--
-- Name: wards_geom_geom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wards_geom_geom_idx ON public.wards USING gist (geom);
--
--

--
--

--
--

--
--

--
-- Name: zone_land_use_controls zone_land_use_controls_land_use_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zone_land_use_controls
    ADD CONSTRAINT zone_land_use_controls_land_use_group_id_fkey FOREIGN KEY (land_use_group_id) REFERENCES public.land_use_groups(id) ON DELETE CASCADE;

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6
-- Name: vungu_proposed_peri_urban_zones; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.vungu_proposed_peri_urban_zones (
    fid integer NOT NULL,
    fid_1 text,
    area_ha text,
    zone text,
    area text,
    lb text,
    shape_leng text,
    shape_area text,
    geom public.geometry(MultiPolygon,4326),
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    zone_type character varying(64),
    zone_code character varying(32),
    scale_category character varying(20),
    authority character varying(100) DEFAULT 'Vungu RDC'::character varying,
    zone_description text,
    ward character varying(64),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
-- Name: vungu_proposed_peri_urban_zones_fid_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.vungu_proposed_peri_urban_zones_fid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: vungu_proposed_peri_urban_zones_fid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.vungu_proposed_peri_urban_zones_fid_seq OWNED BY public.vungu_proposed_peri_urban_zones.fid;
-- Name: vungu_proposed_peri_urban_zones fid; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.vungu_proposed_peri_urban_zones ALTER COLUMN fid SET DEFAULT nextval('public.vungu_proposed_peri_urban_zones_fid_seq'::regclass);
-- Name: vungu_proposed_peri_urban_zones vungu_proposed_peri_urban_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.vungu_proposed_peri_urban_zones
    ADD CONSTRAINT vungu_proposed_peri_urban_zones_pkey PRIMARY KEY (fid);
-- Name: idx_vpuz_active; Type: INDEX; Schema: public; Owner: -
CREATE INDEX idx_vpuz_active ON public.vungu_proposed_peri_urban_zones USING btree (is_active);
-- Name: idx_vpuz_geom; Type: INDEX; Schema: public; Owner: -
CREATE INDEX idx_vpuz_geom ON public.vungu_proposed_peri_urban_zones USING gist (geom);
-- Name: idx_vpuz_id; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX idx_vpuz_id ON public.vungu_proposed_peri_urban_zones USING btree (id);
-- Name: idx_vpuz_type; Type: INDEX; Schema: public; Owner: -
CREATE INDEX idx_vpuz_type ON public.vungu_proposed_peri_urban_zones USING btree (zone_type);
-- Name: idx_vpuz_ward; Type: INDEX; Schema: public; Owner: -
CREATE INDEX idx_vpuz_ward ON public.vungu_proposed_peri_urban_zones USING btree (ward);
-- Name: idx_vungu_proposed_peri_urban_zones_geom; Type: INDEX; Schema: public; Owner: -
CREATE INDEX idx_vungu_proposed_peri_urban_zones_geom ON public.vungu_proposed_peri_urban_zones USING gist (geom);

ALTER TABLE ONLY public.zone_land_use_controls
    ADD CONSTRAINT zone_land_use_controls_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.vungu_proposed_peri_urban_zones(id) ON DELETE CASCADE;
