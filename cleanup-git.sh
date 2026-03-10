#!/bin/bash
# Remove invalid 'nul' file and reset Git state
cd "$(dirname "$0")"

# Remove the invalid file if it exists
if [ -f "nul" ]; then
    rm -f nul
    echo "Removed invalid 'nul' file"
fi

# Reset Git state to clean working directory
if [ -d ".git" ]; then
    git add -A
    git reset --hard HEAD
    echo "Git state reset"
else
    echo "Not a git repository, skipping Git reset"
fi

echo "Cleanup complete"
