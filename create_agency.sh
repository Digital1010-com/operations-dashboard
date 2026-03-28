#!/bin/bash
# Agency Provisioning Script
# Creates isolated agency instance for Design Partner Program

set -e  # Exit on error

# Configuration
DASHBOARD_DIR="/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard"
DATA_DIR="$DASHBOARD_DIR/data"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_header() {
  echo -e "\n${GREEN}=== $1 ===${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

validate_agency_id() {
  if [[ ! "$1" =~ ^[a-z0-9-]+$ ]]; then
    print_error "Invalid agency ID: $1"
    print_error "Agency ID must contain only letters, numbers, and hyphens"
    return 1
  fi
  
  if [ ${#1} -gt 50 ]; then
    print_error "Agency ID too long: $1"
    print_error "Maximum length is 50 characters"
    return 1
  fi
  
  return 0
}

create_agency_data() {
  local agency_id="$1"
  local agency_name="$2"
  
  print_header "Creating Agency: $agency_id"
  
  # Validate agency ID
  if ! validate_agency_id "$agency_id"; then
    return 1
  fi
  
  # Ensure data directory exists
  mkdir -p "$DATA_DIR"
  
  # Check if agency already exists
  local data_file="$DATA_DIR/agency_${agency_id}.json"
  if [ -f "$data_file" ]; then
    print_warning "Agency $agency_id already exists"
    read -p "Overwrite? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      print_warning "Skipping agency creation"
      return 0
    fi
  fi
  
  # Create agency data structure
  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local today=$(date +"%Y-%m-%d")
  
  cat > "$data_file" << JSON
{
  "agencyId": "$agency_id",
  "agencyName": "$agency_name",
  "contactEmail": "",
  "onboardingDate": "$today",
  "projects": [
    {
      "id": "1",
      "name": "Welcome to Mission Control",
      "clientName": "$agency_name",
      "category": "Onboarding",
      "status": "in-progress",
      "description": "Initial setup and configuration for $agency_name",
      "createdDate": "$today",
      "dueDate": "$(date -v+7d +"%Y-%m-%d")"
    }
  ],
  "clients": ["$agency_name"],
  "settings": {
    "theme": "light",
    "notifications": true,
    "weeklyReports": true
  },
  "createdAt": "$timestamp",
  "updatedAt": "$timestamp",
  "accessLog": [
    {
      "timestamp": "$timestamp",
      "action": "agency_created",
      "details": "Provisioned by create_agency.sh"
    }
  ]
}
JSON
  
  if [ $? -eq 0 ]; then
    print_success "Agency data created: $data_file"
    print_success "Agency ID: $agency_id"
    print_success "Agency Name: $agency_name"
    return 0
  else
    print_error "Failed to create agency data"
    return 1
  fi
}

generate_tailscale_key() {
  local agency_id="$1"
  
  print_header "Generating Tailscale Access"
  
  # Check if Tailscale is installed
  if ! command -v tailscale &> /dev/null; then
    print_warning "Tailscale not installed. Skipping key generation."
    print_warning "Install Tailscale: https://tailscale.com/download"
    return 0
  fi
  
  # Check if authenticated
  if ! tailscale status &> /dev/null; then
    print_warning "Tailscale not authenticated. Skipping key generation."
    print_warning "Run: tailscale up"
    return 0
  fi
  
  # Generate auth key (this is a placeholder - actual implementation depends on Tailscale admin)
  print_warning "Tailscale key generation requires admin access."
  print_warning "Manual steps:"
  echo "1. Go to https://login.tailscale.com/admin/authkeys"
  echo "2. Create new auth key for $agency_id"
  echo "3. Set expiry: 90 days"
  echo "4. Note: Reusable, ephemeral"
  echo "5. Share key with agency"
  
  # For now, create a placeholder
  local key_file="$DATA_DIR/tailscale_${agency_id}.txt"
  cat > "$key_file" << TAILSCALE
# TAILSCALE AUTH KEY FOR $agency_id
# Generated: $(date)
# Expires: $(date -v+90d +"%Y-%m-%d")
# 
# INSTRUCTIONS:
# 1. Install Tailscale: https://tailscale.com/download
# 2. Run: tailscale up --authkey YOUR_KEY_HERE
# 3. Access dashboard: http://$(tailscale ip -4)/?agency=$agency_id
# 
# REQUEST KEY FROM: msaad@digital1010.com
TAILSCALE
  
  print_success "Tailscale instructions saved: $key_file"
  return 0
}

create_onboarding_docs() {
  local agency_id="$1"
  local agency_name="$2"
  
  print_header "Creating Onboarding Documentation"
  
  local docs_dir="$DATA_DIR/onboarding_${agency_id}"
  mkdir -p "$docs_dir"
  
  # Create welcome document
  cat > "$docs_dir/WELCOME.md" << DOC
# Welcome to Mission Control Design Partner Program

**Agency:** $agency_name  
**Agency ID:** $agency_id  
**Onboarding Date:** $(date +"%Y-%m-%d")

## Access Instructions

### 1. Dashboard Access
- URL: http://$(hostname):3200/?agency=$agency_id
- Alternative: http://$(tailscale ip -4 2>/dev/null || echo "TAILSCALE_IP")/?agency=$agency_id
- Bookmark this URL

### 2. Weekly Feedback Sessions
- Duration: 30 minutes
- Frequency: Weekly
- Purpose: Share feedback, request features
- Schedule: Calendly link will be provided

### 3. Getting Started
1. **Explore the dashboard** - Familiarize yourself with the interface
2. **Add your projects** - Start with 1-2 real agency projects
3. **Provide feedback** - Use the feedback form in dashboard
4. **Join weekly call** - Discuss pain points and improvements

## Support
- Email: msaad@digital1010.com
- Response time: < 24 hours
- Emergency: Slack channel access provided separately

## Success Metrics
We'll track:
- Hours saved on client reporting
- Team efficiency improvements  
- Feature requests implemented
- Overall satisfaction

**Thank you for helping shape the future of agency operations!**

Michael Saad  
CEO, Digital1010
DOC
  
  # Create quick start guide
  cat > "$docs_dir/QUICK_START.md" << GUIDE
# Quick Start Guide - Mission Control

## Day 1: Exploration
1. Login to dashboard
2. Add your first project
3. Explore all menu options
4. Submit initial feedback

## Week 1: Integration  
1. Add 3-5 real agency projects
2. Test with team members
3. Document pain points
4. Prepare for first feedback session

## Month 1: Optimization
1. Provide detailed feature requests
2. Share before/after time savings
3. Participate in roadmap planning
4. Consider case study participation

## Pro Tips
- Start small (1-2 projects)
- Involve your team early
- Be specific in feedback
- Track time savings
GUIDE
  
  print_success "Onboarding docs created: $docs_dir/"
  return 0
}

test_agency_access() {
  local agency_id="$1"
  
  print_header "Testing Agency Access"
  
  # Check if server is running
  if ! curl -s http://localhost:3200/api/ping > /dev/null; then
    print_warning "Dashboard server not running. Start with:"
    echo "  cd $DASHBOARD_DIR && node server-multi-tenant.js"
    return 0
  fi
  
  # Test agency-specific endpoint
  local response=$(curl -s "http://localhost:3200/api/operations?agency=$agency_id")
  
  if echo "$response" | grep -q '"agency":"'"$agency_id"'"'; then
    print_success "Agency access verified: $agency_id"
    
    # Extract project count
    local projects=$(echo "$response" | grep -o '"total":[0-9]*' | cut -d: -f2)
    print_success "Initial projects: $projects"
  else
    print_error "Agency access test failed"
    print_error "Response: $response"
    return 1
  fi
  
  return 0
}

create_agency_summary() {
  local agency_id="$1"
  local agency_name="$2"
  
  print_header "AGENCY PROVISIONING COMPLETE"
  echo ""
  echo "Agency ID:    $agency_id"
  echo "Agency Name:  $agency_name"
  echo "Created:      $(date)"
  echo ""
  echo "Files Created:"
  echo "  • $DATA_DIR/agency_${agency_id}.json"
  echo "  • $DATA_DIR/tailscale_${agency_id}.txt (instructions)"
  echo "  • $DATA_DIR/onboarding_${agency_id}/ (docs)"
  echo ""
  echo "Access URL:"
  echo "  http://localhost:3200/?agency=$agency_id"
  echo ""
  echo "Next Steps:"
  echo "  1. Share Tailscale instructions with agency"
  echo "  2. Schedule onboarding call"
  echo "  3. Send welcome email with docs"
  echo "  4. Monitor initial usage"
  echo ""
  echo "Dashboard running? $(curl -s http://localhost:3200/api/ping > /dev/null && echo "✅ Yes" || echo "❌ No")"
}

# Main execution
main() {
  if [ $# -lt 2 ]; then
    echo "Usage: $0 <agency-id> <agency-name>"
    echo "Example: $0 partner1 'Acme Marketing Agency'"
    echo ""
    echo "Agency ID rules:"
    echo "  • Letters, numbers, hyphens only"
    echo "  • Max 50 characters"
    echo "  • Example: partner1, test-agency, alpha-beta"
    exit 1
  fi
  
  local agency_id="$1"
  local agency_name="${@:2}"  # All remaining arguments as name
  
  # Change to dashboard directory
  cd "$DASHBOARD_DIR" || {
    print_error "Cannot access dashboard directory: $DASHBOARD_DIR"
    exit 1
  }
  
  # Execute provisioning steps
  create_agency_data "$agency_id" "$agency_name" || exit 1
  generate_tailscale_key "$agency_id"
  create_onboarding_docs "$agency_id" "$agency_name"
  test_agency_access "$agency_id"
  create_agency_summary "$agency_id" "$agency_name"
}

# Run main function with all arguments
main "$@"
