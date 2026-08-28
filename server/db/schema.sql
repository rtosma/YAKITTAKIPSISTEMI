-- ==============================================================================
-- [ARCH-101] PostgreSQL Row-Level Security (RLS) & Multi-Tenancy Schema Setup
-- ==============================================================================

-- 1. Companies Table
CREATE TABLE IF NOT EXISTS companies (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tax_number VARCHAR(32) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Vehicles Table with Tenant ID
CREATE TABLE IF NOT EXISTS vehicles (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plate VARCHAR(32) NOT NULL,
    brand_model VARCHAR(128) NOT NULL,
    vehicle_type VARCHAR(64) NOT NULL,
    rfid_tag VARCHAR(64) NOT NULL,
    status VARCHAR(32) DEFAULT 'AKTİF',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tanks Table with Tenant ID
CREATE TABLE IF NOT EXISTS tanks (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    capacity_liters NUMERIC(10, 2) NOT NULL,
    current_level_liters NUMERIC(10, 2) NOT NULL,
    fuel_type VARCHAR(64) DEFAULT 'Motorin',
    status VARCHAR(32) DEFAULT 'GÜVENLİ',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 4. Enable Row Level Security (RLS) Policies
-- ==============================================================================

-- Enable RLS on vehicles
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;

-- Enable RLS on tanks
ALTER TABLE tanks ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS vehicles_tenant_isolation_policy ON vehicles;
DROP POLICY IF EXISTS tanks_tenant_isolation_policy ON tanks;

-- Create Tenant Isolation Policy for vehicles
-- current_setting('app.current_tenant_id', true) reads the session variable set by SET LOCAL
CREATE POLICY vehicles_tenant_isolation_policy ON vehicles
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for tanks
CREATE POLICY tanks_tenant_isolation_policy ON tanks
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
