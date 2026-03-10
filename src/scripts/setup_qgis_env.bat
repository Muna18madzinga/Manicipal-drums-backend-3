@echo off
REM QGIS Environment Setup Script
REM This script properly initializes the QGIS environment for PyQGIS

REM Set QGIS installation path
set QGIS_INSTALL_PATH=C:\Program Files\QGIS 3.44.3

REM Initialize OSGeo4W environment
call "%QGIS_INSTALL_PATH%\bin\o4w_env.bat"

REM Set additional environment variables
set QGIS_PREFIX_PATH=%OSGEO4W_ROOT:\=/%/apps/qgis
set GDAL_FILENAME_IS_UTF8=YES
set VSI_CACHE=TRUE
set VSI_CACHE_SIZE=1000000
set QT_PLUGIN_PATH=%OSGEO4W_ROOT%\apps\qgis\qtplugins;%OSGEO4W_ROOT%\apps\qt5\plugins
set PYTHONPATH=%OSGEO4W_ROOT%\apps\qgis\python;%PYTHONPATH%

REM Add QGIS Python to PATH
set PATH=%QGIS_INSTALL_PATH%\bin;%PATH%

echo QGIS Environment Initialized
echo QGIS_PREFIX_PATH: %QGIS_PREFIX_PATH%
echo PYTHONPATH: %PYTHONPATH%
echo PATH: %PATH%
