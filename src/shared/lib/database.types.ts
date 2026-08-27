export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      categories: {
        Row: {
          company_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          organization_id: string
          parent_id: string | null
          position: number
          slug: string
          store_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          parent_id?: string | null
          position?: number
          slug: string
          store_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          parent_id?: string | null
          position?: number
          slug?: string
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_fk"
            columns: ["parent_id", "store_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "categories_parent_fk"
            columns: ["parent_id", "store_id"]
            isOneToOne: false
            referencedRelation: "public_categories"
            referencedColumns: ["category_id", "store_id"]
          },
          {
            foreignKeyName: "categories_store_fk"
            columns: ["store_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
        ]
      }
      currencies: {
        Row: {
          code: string
          created_at: string
          is_active: boolean
          minor_unit: number
          name: string
          symbol: string
        }
        Insert: {
          code: string
          created_at?: string
          is_active?: boolean
          minor_unit?: number
          name: string
          symbol: string
        }
        Update: {
          code?: string
          created_at?: string
          is_active?: boolean
          minor_unit?: number
          name?: string
          symbol?: string
        }
        Relationships: []
      }
      order_items: {
        Row: {
          company_id: string
          created_at: string
          id: string
          line_total: number | null
          name: string
          order_id: string
          organization_id: string
          product_id: string | null
          quantity: number
          sku: string
          store_id: string
          unit_price: number
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          line_total?: number | null
          name: string
          order_id: string
          organization_id: string
          product_id?: string | null
          quantity: number
          sku: string
          store_id: string
          unit_price: number
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          line_total?: number | null
          name?: string
          order_id?: string
          organization_id?: string
          product_id?: string | null
          quantity?: number
          sku?: string
          store_id?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_fk"
            columns: ["order_id", "store_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "order_items_product_fk"
            columns: ["product_id", "store_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "order_items_product_fk"
            columns: ["product_id", "store_id"]
            isOneToOne: false
            referencedRelation: "public_products"
            referencedColumns: ["product_id", "store_id"]
          },
          {
            foreignKeyName: "order_items_store_fk"
            columns: ["store_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
        ]
      }
      order_status_events: {
        Row: {
          actor_email: string | null
          actor_id: string | null
          company_id: string
          created_at: string
          from_status: Database["public"]["Enums"]["order_status"] | null
          id: string
          note: string | null
          order_id: string
          organization_id: string
          store_id: string
          to_status: Database["public"]["Enums"]["order_status"]
        }
        Insert: {
          actor_email?: string | null
          actor_id?: string | null
          company_id: string
          created_at?: string
          from_status?: Database["public"]["Enums"]["order_status"] | null
          id?: string
          note?: string | null
          order_id: string
          organization_id: string
          store_id: string
          to_status: Database["public"]["Enums"]["order_status"]
        }
        Update: {
          actor_email?: string | null
          actor_id?: string | null
          company_id?: string
          created_at?: string
          from_status?: Database["public"]["Enums"]["order_status"] | null
          id?: string
          note?: string | null
          order_id?: string
          organization_id?: string
          store_id?: string
          to_status?: Database["public"]["Enums"]["order_status"]
        }
        Relationships: [
          {
            foreignKeyName: "order_status_events_order_fk"
            columns: ["order_id", "store_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "order_status_events_store_fk"
            columns: ["store_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
        ]
      }
      orders: {
        Row: {
          company_id: string
          created_at: string
          currency: string
          customer_email: string
          customer_name: string | null
          customer_phone: string | null
          discount_total: number
          grand_total: number
          id: string
          notes: string | null
          order_number: string
          organization_id: string
          placed_at: string
          shipping_address: Json
          shipping_total: number
          status: Database["public"]["Enums"]["order_status"]
          store_id: string
          subtotal: number
          tax_total: number
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          currency: string
          customer_email: string
          customer_name?: string | null
          customer_phone?: string | null
          discount_total?: number
          grand_total?: number
          id?: string
          notes?: string | null
          order_number: string
          organization_id: string
          placed_at?: string
          shipping_address?: Json
          shipping_total?: number
          status?: Database["public"]["Enums"]["order_status"]
          store_id: string
          subtotal?: number
          tax_total?: number
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          currency?: string
          customer_email?: string
          customer_name?: string | null
          customer_phone?: string | null
          discount_total?: number
          grand_total?: number
          id?: string
          notes?: string | null
          order_number?: string
          organization_id?: string
          placed_at?: string
          shipping_address?: Json
          shipping_total?: number
          status?: Database["public"]["Enums"]["order_status"]
          store_id?: string
          subtotal?: number
          tax_total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_store_fk"
            columns: ["store_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
        ]
      }
      product_images: {
        Row: {
          alt: string | null
          company_id: string
          created_at: string
          id: string
          is_primary: boolean
          organization_id: string
          position: number
          product_id: string
          storage_path: string
          store_id: string
          updated_at: string
        }
        Insert: {
          alt?: string | null
          company_id: string
          created_at?: string
          id?: string
          is_primary?: boolean
          organization_id: string
          position?: number
          product_id: string
          storage_path: string
          store_id: string
          updated_at?: string
        }
        Update: {
          alt?: string | null
          company_id?: string
          created_at?: string
          id?: string
          is_primary?: boolean
          organization_id?: string
          position?: number
          product_id?: string
          storage_path?: string
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_images_product_fk"
            columns: ["product_id", "store_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "product_images_product_fk"
            columns: ["product_id", "store_id"]
            isOneToOne: false
            referencedRelation: "public_products"
            referencedColumns: ["product_id", "store_id"]
          },
          {
            foreignKeyName: "product_images_store_fk"
            columns: ["store_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
        ]
      }
      products: {
        Row: {
          category_id: string | null
          company_id: string
          compare_at_price: number | null
          created_at: string
          currency: string
          custom_fields: Json
          description: string | null
          id: string
          in_stock: boolean | null
          name: string
          organization_id: string
          price: number
          published_at: string | null
          sku: string
          slug: string
          status: Database["public"]["Enums"]["product_status"]
          stock: number
          store_id: string
          tax_category_id: string | null
          updated_at: string
        }
        Insert: {
          category_id?: string | null
          company_id: string
          compare_at_price?: number | null
          created_at?: string
          currency?: string
          custom_fields?: Json
          description?: string | null
          id?: string
          in_stock?: boolean | null
          name: string
          organization_id: string
          price: number
          published_at?: string | null
          sku: string
          slug: string
          status?: Database["public"]["Enums"]["product_status"]
          stock?: number
          store_id: string
          tax_category_id?: string | null
          updated_at?: string
        }
        Update: {
          category_id?: string | null
          company_id?: string
          compare_at_price?: number | null
          created_at?: string
          currency?: string
          custom_fields?: Json
          description?: string | null
          id?: string
          in_stock?: boolean | null
          name?: string
          organization_id?: string
          price?: number
          published_at?: string | null
          sku?: string
          slug?: string
          status?: Database["public"]["Enums"]["product_status"]
          stock?: number
          store_id?: string
          tax_category_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_category_fk"
            columns: ["category_id", "store_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "products_category_fk"
            columns: ["category_id", "store_id"]
            isOneToOne: false
            referencedRelation: "public_categories"
            referencedColumns: ["category_id", "store_id"]
          },
          {
            foreignKeyName: "products_currency_fk"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "products_store_fk"
            columns: ["store_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
          {
            foreignKeyName: "products_tax_category_fk"
            columns: ["tax_category_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "tax_categories"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
        ]
      }
      store_settings: {
        Row: {
          accent_color: string
          banner_url: string | null
          company_id: string
          config: Json
          contact_address: string | null
          contact_phone: string | null
          created_at: string
          default_locale: string
          favicon_url: string | null
          hero_subtitle: string | null
          hero_title: string | null
          logo_url: string | null
          organization_id: string
          store_id: string
          support_email: string | null
          tax_category_id: string | null
          tax_inclusive: boolean
          tax_rate: number
          updated_at: string
          white_label: boolean
        }
        Insert: {
          accent_color?: string
          banner_url?: string | null
          company_id: string
          config?: Json
          contact_address?: string | null
          contact_phone?: string | null
          created_at?: string
          default_locale?: string
          favicon_url?: string | null
          hero_subtitle?: string | null
          hero_title?: string | null
          logo_url?: string | null
          organization_id: string
          store_id: string
          support_email?: string | null
          tax_category_id?: string | null
          tax_inclusive?: boolean
          tax_rate?: number
          updated_at?: string
          white_label?: boolean
        }
        Update: {
          accent_color?: string
          banner_url?: string | null
          company_id?: string
          config?: Json
          contact_address?: string | null
          contact_phone?: string | null
          created_at?: string
          default_locale?: string
          favicon_url?: string | null
          hero_subtitle?: string | null
          hero_title?: string | null
          logo_url?: string | null
          organization_id?: string
          store_id?: string
          support_email?: string | null
          tax_category_id?: string | null
          tax_inclusive?: boolean
          tax_rate?: number
          updated_at?: string
          white_label?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "store_settings_store_fk"
            columns: ["store_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
          {
            foreignKeyName: "store_settings_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "public_stores"
            referencedColumns: ["store_id"]
          },
          {
            foreignKeyName: "store_settings_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_settings_tax_category_fk"
            columns: ["tax_category_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "tax_categories"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
        ]
      }
      stores: {
        Row: {
          company_id: string
          created_at: string
          currency: string
          domain: string | null
          id: string
          name: string
          order_seq: number
          organization_id: string
          slug: string
          status: Database["public"]["Enums"]["store_status"]
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          currency: string
          domain?: string | null
          id?: string
          name: string
          order_seq?: number
          organization_id: string
          slug: string
          status?: Database["public"]["Enums"]["store_status"]
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          currency?: string
          domain?: string | null
          id?: string
          name?: string
          order_seq?: number
          organization_id?: string
          slug?: string
          status?: Database["public"]["Enums"]["store_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stores_currency_fk"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "stores_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      tax_categories: {
        Row: {
          code: string
          company_id: string
          created_at: string
          id: string
          is_default: boolean
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          code: string
          company_id: string
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          code?: string
          company_id?: string
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      tax_rates: {
        Row: {
          company_id: string
          created_at: string
          id: string
          organization_id: string
          rate: number
          tax_category_id: string
          updated_at: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          organization_id: string
          rate: number
          tax_category_id: string
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          rate?: number
          tax_category_id?: string
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_rates_category_fk"
            columns: ["tax_category_id", "organization_id", "company_id"]
            isOneToOne: false
            referencedRelation: "tax_categories"
            referencedColumns: ["id", "organization_id", "company_id"]
          },
        ]
      }
      tenant_currencies: {
        Row: {
          company_id: string
          created_at: string
          currency: string
          id: string
          is_base: boolean
          organization_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          currency: string
          id?: string
          is_base?: boolean
          organization_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          currency?: string
          id?: string
          is_base?: boolean
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_currencies_currency_fkey"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      tenant_members: {
        Row: {
          company_id: string
          created_at: string
          email: string
          id: string
          organization_id: string
          role: Database["public"]["Enums"]["app_role"]
          status: Database["public"]["Enums"]["member_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          email: string
          id?: string
          organization_id: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: Database["public"]["Enums"]["member_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          email?: string
          id?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: Database["public"]["Enums"]["member_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["organization_id"]
          },
        ]
      }
      tenants: {
        Row: {
          admin_email: string
          created_at: string
          name: string
          organization_id: string
          settings: Json
          slug: string
          status: Database["public"]["Enums"]["tenant_status"]
          updated_at: string
        }
        Insert: {
          admin_email: string
          created_at?: string
          name: string
          organization_id: string
          settings?: Json
          slug: string
          status?: Database["public"]["Enums"]["tenant_status"]
          updated_at?: string
        }
        Update: {
          admin_email?: string
          created_at?: string
          name?: string
          organization_id?: string
          settings?: Json
          slug?: string
          status?: Database["public"]["Enums"]["tenant_status"]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      public_categories: {
        Row: {
          category_id: string | null
          name: string | null
          parent_id: string | null
          position: number | null
          slug: string | null
          store_id: string | null
        }
        Insert: {
          category_id?: string | null
          name?: string | null
          parent_id?: string | null
          position?: number | null
          slug?: string | null
          store_id?: string | null
        }
        Update: {
          category_id?: string | null
          name?: string | null
          parent_id?: string | null
          position?: number | null
          slug?: string | null
          store_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_fk"
            columns: ["parent_id", "store_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "categories_parent_fk"
            columns: ["parent_id", "store_id"]
            isOneToOne: false
            referencedRelation: "public_categories"
            referencedColumns: ["category_id", "store_id"]
          },
        ]
      }
      public_product_images: {
        Row: {
          alt: string | null
          image_id: string | null
          is_primary: boolean | null
          position: number | null
          product_id: string | null
          storage_path: string | null
          store_id: string | null
        }
        Insert: {
          alt?: string | null
          image_id?: string | null
          is_primary?: boolean | null
          position?: number | null
          product_id?: string | null
          storage_path?: string | null
          store_id?: string | null
        }
        Update: {
          alt?: string | null
          image_id?: string | null
          is_primary?: boolean | null
          position?: number | null
          product_id?: string | null
          storage_path?: string | null
          store_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_images_product_fk"
            columns: ["product_id", "store_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "product_images_product_fk"
            columns: ["product_id", "store_id"]
            isOneToOne: false
            referencedRelation: "public_products"
            referencedColumns: ["product_id", "store_id"]
          },
        ]
      }
      public_products: {
        Row: {
          category_id: string | null
          category_name: string | null
          category_slug: string | null
          compare_at_price: number | null
          currency: string | null
          custom_fields: Json | null
          description: string | null
          in_stock: boolean | null
          name: string | null
          price: number | null
          primary_image_alt: string | null
          primary_image_path: string | null
          product_id: string | null
          published_at: string | null
          slug: string | null
          store_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_category_fk"
            columns: ["category_id", "store_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "products_category_fk"
            columns: ["category_id", "store_id"]
            isOneToOne: false
            referencedRelation: "public_categories"
            referencedColumns: ["category_id", "store_id"]
          },
          {
            foreignKeyName: "products_currency_fk"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      public_store_branding: {
        Row: {
          accent_color: string | null
          brand_slug: string | null
          logo_url: string | null
          name: string | null
          white_label: boolean | null
        }
        Relationships: []
      }
      public_stores: {
        Row: {
          accent_color: string | null
          banner_url: string | null
          contact_address: string | null
          contact_phone: string | null
          currency: string | null
          default_locale: string | null
          domain: string | null
          favicon_url: string | null
          hero_subtitle: string | null
          hero_title: string | null
          logo_url: string | null
          name: string | null
          slug: string | null
          store_id: string | null
          support_email: string | null
          white_label: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "stores_currency_fk"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
        ]
      }
    }
    Functions: {
      bootstrap_tenant: {
        Args: {
          p_admin_email: string
          p_company_id: string
          p_currency?: string
          p_organization_id: string
          p_owner_user_id: string
          p_store_name: string
          p_store_slug: string
          p_tenant_name: string
          p_tenant_slug: string
        }
        Returns: Json
      }
      category_deletion_usage: {
        Args: { p_category_id: string }
        Returns: Json
      }
      create_order: {
        Args: {
          p_customer_email: string
          p_customer_name?: string
          p_customer_phone?: string
          p_items: Json
          p_notes?: string
          p_shipping_address?: Json
          p_store_id: string
        }
        Returns: Json
      }
      create_order_for_slug: {
        Args: {
          p_customer_email: string
          p_customer_name?: string
          p_customer_phone?: string
          p_items: Json
          p_notes?: string
          p_shipping_address?: Json
          p_store_slug: string
        }
        Returns: Json
      }
      dashboard_kpis: { Args: { p_store_id?: string }; Returns: Json }
      product_deletion_usage: { Args: { p_product_id: string }; Returns: Json }
      reorder_product_images: {
        Args: { p_image_ids: string[]; p_product_id: string }
        Returns: undefined
      }
      set_primary_product_image: {
        Args: { p_image_id: string }
        Returns: undefined
      }
      set_tax_rate: {
        Args: { p_rate: number; p_tax_category_id: string }
        Returns: Json
      }
    }
    Enums: {
      app_role: "owner" | "admin" | "catalog" | "orders" | "viewer"
      member_status: "active" | "invited" | "revoked"
      order_status: "pending" | "paid" | "fulfilled" | "cancelled" | "refunded"
      product_status: "draft" | "published" | "archived"
      store_status: "draft" | "active" | "suspended"
      tenant_status: "active" | "suspended" | "closed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "admin", "catalog", "orders", "viewer"],
      member_status: ["active", "invited", "revoked"],
      order_status: ["pending", "paid", "fulfilled", "cancelled", "refunded"],
      product_status: ["draft", "published", "archived"],
      store_status: ["draft", "active", "suspended"],
      tenant_status: ["active", "suspended", "closed"],
    },
  },
} as const
