#!/bin/bash

# Emergent Builder - Quick Start Script
# Usage: ./quickstart.sh /path/to/your/project

set -e

PROJECT_PATH="${1:-$(pwd)}"

echo "🚀 Emergent Builder Quick Start"
echo "   Target project: $PROJECT_PATH"
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 20+"
    exit 1
fi

if ! command -v claude &> /dev/null; then
    echo "❌ Claude Code CLI not found."
    echo "   Install with: npm install -g @anthropic-ai/claude-code"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo "❌ Git not found. Please install git."
    exit 1
fi

echo "✅ Prerequisites OK"
echo ""

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Create orchestration directory in target project if it doesn't exist
if [ ! -d "$PROJECT_PATH/orchestration" ]; then
    echo "Creating orchestration directory in target project..."
    mkdir -p "$PROJECT_PATH/orchestration/jobs/pending"
    mkdir -p "$PROJECT_PATH/orchestration/jobs/in-progress"
    mkdir -p "$PROJECT_PATH/orchestration/jobs/completed"
    mkdir -p "$PROJECT_PATH/orchestration/jobs/failed"
    
    # Copy template files
    cp orchestration/COORDINATOR_PROMPT.md "$PROJECT_PATH/orchestration/"
    cp orchestration/PRODUCT_VISION.md "$PROJECT_PATH/orchestration/"
    
    echo "✅ Orchestration directory created"
    echo ""
    echo "⚠️  IMPORTANT: Edit $PROJECT_PATH/orchestration/PRODUCT_VISION.md"
    echo "   Customize it for your specific project before running."
    echo ""
    read -p "Press Enter after you've edited the PRODUCT_VISION.md..."
fi

# Run the simple version
echo ""
echo "Starting Emergent Builder..."
echo "─────────────────────────────────────────────────────────"
REPO_PATH="$PROJECT_PATH" ORCHESTRATION_DIR="$PROJECT_PATH/orchestration" npx tsx simple-runner.ts
